// ---------------------------------------------------------------------------
// EVAL ENGINE: synthetic Recall@k for retrieval.
//
// For each chunk we ask the LLM to author a natural question the chunk answers
// (the chunk is the ground-truth label). Scoring is pure retrieval — embed the
// question, vector-search, and check whether the labeled chunk is in the top-k.
// No LLM runs at scoring time.
//
// Known limitations (by design for v1):
//   - Strict chunk-id match can undercount when overlapping/duplicate chunks
//     legitimately answer the same question — a recall floor, not a bug.
//   - Synthetic questions skew easier than real user queries, so recall is an
//     optimistic estimate; the generation prompt mitigates lexical copying.
//   - Retrieval searches the whole model+dim chunks table (all docs/configs that
//     share it); fine with today's single fixed config.
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { anthropicClient } from "@/lib/llm/client";
import { retrieve } from "@/lib/rag/retriever";
import {
  chunksNeedingQuestions,
  createRunSnapshot,
  getSummary,
  insertQuestionWithLabel,
  insertResults,
  questionsNeedingScoring,
  type ResultInsert,
} from "@/lib/rag/evalStore";

// Static across every chunk, so it can sit in a cached prefix. Kept deliberately
// strict about NOT quoting the passage — verbatim questions make retrieval
// trivial and inflate recall.
const GENERATION_SYSTEM =
  "You write evaluation questions for a retrieval system. Given a passage from " +
  "a document, write natural questions that a user might ask whose answer is " +
  "found in THAT passage. Rules: (1) Write the question as a real user would " +
  "phrase it — do NOT quote or closely paraphrase the passage's wording, since " +
  "that makes retrieval trivially easy. (2) Each question must be answerable " +
  "from the passage alone. (3) Keep questions self-contained (no 'this passage' " +
  "or 'the text above'). Also provide a short expected_answer drawn from the " +
  "passage for each question.";

// JSON-schema-constrained output so we never have to defensively parse prose.
const QUESTIONS_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            expected_answer: { type: "string" },
          },
          required: ["question", "expected_answer"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

type GeneratedQuestion = { question: string; expected_answer: string };

async function authorQuestions(
  text: string,
  count: number,
): Promise<GeneratedQuestion[]> {
  const response = await anthropicClient.messages.create({
    model: config.llmModel,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: { format: QUESTIONS_FORMAT },
    system: [
      {
        type: "text",
        text: GENERATION_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content:
          `Write exactly ${count} question(s) for this passage:\n\n${text}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];
  const parsed = JSON.parse(textBlock.text) as { questions?: GeneratedQuestion[] };
  return (parsed.questions ?? []).slice(0, count);
}

// Top up every under-target chunk to `evalQuestionsPerChunk` questions. Only
// chunks below target are touched, so this is naturally incremental.
export async function generateMissingQuestions(): Promise<number> {
  const chunks = await chunksNeedingQuestions(config.evalQuestionsPerChunk);
  if (chunks.length === 0) return 0;

  console.log(
    `[rag:eval] generating questions for ${chunks.length} chunk(s) under target=${config.evalQuestionsPerChunk}`,
  );

  let generated = 0;
  for (const chunk of chunks) {
    const questions = await authorQuestions(chunk.text, chunk.needed);
    for (const q of questions) {
      if (!q.question.trim()) continue;
      await insertQuestionWithLabel({
        documentId: chunk.documentId,
        documentEmbeddingId: chunk.documentEmbeddingId,
        sourceChunkId: chunk.chunkId,
        question: q.question.trim(),
        expectedAnswer: q.expected_answer?.trim() || null,
        generatorModel: config.llmModel,
      });
      generated += 1;
    }
  }

  console.log(`[rag:eval] generated ${generated} question(s)`);
  return generated;
}

// Score every question that has no fresh result (new or edited since last score).
export async function scoreUnscoredQuestions(): Promise<number> {
  const pending = await questionsNeedingScoring();
  if (pending.length === 0) return 0;

  console.log(`[rag:eval] scoring ${pending.length} question(s) @ k=${config.topK}`);

  const results: ResultInsert[] = [];
  for (const q of pending) {
    const retrieved = await retrieve(q.question);
    const ids = retrieved.map((r) => r.chunk.chunk.id);
    const rank = ids.indexOf(q.sourceChunkId);
    results.push({
      questionId: q.questionId,
      labelId: q.labelId,
      k: config.topK,
      hit: rank !== -1,
      foundRank: rank === -1 ? null : rank + 1,
      retrievedIds: ids,
    });
  }

  await insertResults(results);
  return results.length;
}

// The "Process new chunks" button: generate questions for new chunks, score
// what's unscored, then freeze a comparison snapshot of the current aggregate.
export async function processNewChunks(): Promise<{
  generated: number;
  scored: number;
  recall: number | null;
}> {
  const t0 = performance.now();
  const generated = await generateMissingQuestions();
  const scored = await scoreUnscoredQuestions();

  const summary = await getSummary();
  await createRunSnapshot({
    questionCount: summary.scored,
    hitCount: summary.hits,
  });

  console.log(
    `[rag:eval] processNewChunks done: generated=${generated} scored=${scored} ` +
      `recall=${summary.recall ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  return { generated, scored, recall: summary.recall };
}
