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
import { altEmbeddingModels, config } from "@/lib/config";
import { anthropicClient } from "@/lib/llm/client";
import { splitText, tokenizeWithOffsets } from "@/lib/rag/chunker";
import { cosine, embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
import { embedQuery, embedTexts } from "@/lib/rag/embeddings";
import { stitchChunks } from "@/lib/rag/reconstruct";
import { retrieveWithVector } from "@/lib/rag/retriever";
import {
  allLabeledQuestions,
  chunksNeedingQuestions,
  createRunSnapshot,
  getCachedQueryEmbeddings,
  getChunkForGeneration,
  getChunksByIds,
  getChunkWindow,
  getCorpusChunkList,
  getExperimentContext,
  getModelTrialChunk,
  getModelTrialQuestions,
  getSummary,
  insertModelTrial,
  insertQuestionWithLabel,
  insertResults,
  listModelTrials,
  putCachedQueryEmbedding,
  questionsNeedingScoring,
  rankWithSubstitutedChunk,
  type CorpusChunkListItem,
  type ExperimentContext,
  type PoolChunk,
  type QuestionToScore,
  type ResultInsert,
  type SavedModelTrial,
  type TrialPoolHit,
  type TrialQuestionOutcome,
} from "@/lib/rag/evalStore";

// Progress events streamed to the client during a process/rescore run. The
// routes serialize these as NDJSON; the dashboard turns them into a two-phase
// progress bar and flips question badges live as each result lands.
export type EvalEvent =
  | { type: "generate-start"; total: number }
  | { type: "generate-progress"; done: number; total: number }
  | { type: "score-start"; total: number }
  | {
      type: "score-result";
      done: number;
      total: number;
      questionId: string;
      hit: boolean;
      foundRank: number | null;
    }
  | {
      type: "done";
      generated: number;
      scored: number;
      recall: number | null;
      mrr: number | null;
      ndcg: number | null;
    }
  | { type: "error"; message: string };

type Emit = (event: EvalEvent) => void;

// On-demand synthetic questions can target a difficulty — a dial on how far the
// question's wording drifts from the passage's surface form. Higher difficulty
// means less lexical overlap, so retrieval is stress-tested with harder queries.
export type Difficulty = "easy" | "medium" | "hard";

// Per-difficulty steer, appended to the (per-chunk, uncached) user turn so the
// static system prompt below stays a cache-stable prefix. Every level keeps the
// answer uniquely grounded in this passage — otherwise a too-obscure "hard"
// question could be better answered by another chunk and unfairly tank recall.
function difficultyInstruction(difficulty: Difficulty): string {
  switch (difficulty) {
    case "easy":
      return (
        "Difficulty: EASY. Ask a direct, factual question. You may reuse the " +
        "passage's key terms and nouns; the answer should be obvious to anyone " +
        "who has read it."
      );
    case "medium":
      return (
        "Difficulty: MEDIUM. Rephrase entirely in your own words — avoid the " +
        "passage's distinctive phrasing and prefer synonyms — but keep it a " +
        "natural, direct question."
      );
    case "hard":
      return (
        "Difficulty: HARD. Ask indirectly or from a higher level of abstraction " +
        '(e.g. an applied, "how would I…", or downstream-consequence angle). ' +
        "Share no distinctive vocabulary with the passage and require the reader " +
        "to connect concepts. The answer MUST still be found uniquely and " +
        "completely within this passage — never answerable from general " +
        "knowledge or from a different passage."
      );
  }
}

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
  difficulty?: Difficulty,
): Promise<GeneratedQuestion[]> {
  // The difficulty steer (when set) leads the user turn; the passage follows.
  const steer = difficulty ? `${difficultyInstruction(difficulty)}\n\n` : "";
  const response = await anthropicClient.messages.create({
    model: config.llmModel,
    // Scale headroom with the ask so a larger target can't truncate the JSON.
    max_tokens: Math.min(1024 + (count - 1) * 512, 4096),
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
          `${steer}Write exactly ${count} question(s) for this passage:\n\n${text}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];

  // Structured outputs guarantee schema-valid JSON on a clean stop, but a
  // truncation (max_tokens) or refusal can still yield unparseable text. Skip
  // this chunk rather than failing the whole run — it stays under target and is
  // retried on the next pass.
  try {
    const parsed = JSON.parse(textBlock.text) as { questions?: GeneratedQuestion[] };
    return (parsed.questions ?? []).slice(0, count);
  } catch {
    console.warn(
      `[rag:eval] could not parse generated questions (stop_reason=${response.stop_reason}); skipping chunk`,
    );
    return [];
  }
}

// Top up every under-target chunk to `evalQuestionsPerChunk` questions. Only
// chunks below target are touched, so this is naturally incremental.
export async function generateMissingQuestions(emit: Emit = () => {}): Promise<number> {
  const chunks = await chunksNeedingQuestions(config.evalQuestionsPerChunk);
  if (chunks.length === 0) return 0;

  console.log(
    `[rag:eval] generating questions for ${chunks.length} chunk(s) under target=${config.evalQuestionsPerChunk}`,
  );
  emit({ type: "generate-start", total: chunks.length });

  let generated = 0;
  let done = 0;
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
    done += 1;
    emit({ type: "generate-progress", done, total: chunks.length });
  }

  console.log(`[rag:eval] generated ${generated} question(s)`);
  return generated;
}

// Author one synthetic question for a single chunk at the requested difficulty
// and persist it (source 'generated', unscored until the next run) — the
// on-demand counterpart to the bulk generator above. Returns "not-found" when
// the chunk isn't part of the active config, "empty" when the model returned no
// usable question (truncation/refusal), else "ok".
export async function generateQuestionForChunk(
  chunkId: string,
  difficulty: Difficulty,
): Promise<"ok" | "not-found" | "empty"> {
  const chunk = await getChunkForGeneration(chunkId);
  if (!chunk) return "not-found";

  const [q] = await authorQuestions(chunk.text, 1, difficulty);
  if (!q || !q.question.trim()) return "empty";

  await insertQuestionWithLabel({
    documentId: chunk.documentId,
    documentEmbeddingId: chunk.documentEmbeddingId,
    sourceChunkId: chunkId,
    question: q.question.trim(),
    expectedAnswer: q.expected_answer?.trim() || null,
    generatorModel: config.llmModel,
    difficulty,
  });
  return "ok";
}

// Embed each question, vector-search, and record whether its labeled chunk landed in
// the top-k. Pure retrieval — no LLM at scoring time. Shared by the incremental
// (scoreUnscoredQuestions) and full (rescoreAllQuestions) scoring paths.
//
// A question's query vector depends only on (text, model), so we reuse cached
// vectors and embed only cache misses (caching them as we go). On a warm cache
// each iteration is just a fast vector search — the win that makes repeat
// "Re-score all" runs cheap. Misses still embed one-at-a-time inside the loop so
// the per-question progress bar stays accurate.
async function scoreQuestions(
  questions: QuestionToScore[],
  emit: Emit = () => {},
): Promise<number> {
  if (questions.length === 0) return 0;

  emit({ type: "score-start", total: questions.length });

  const cached = await getCachedQueryEmbeddings(
    questions.map((q) => q.questionId),
    config.embeddingModel,
  );

  const results: ResultInsert[] = [];
  let done = 0;
  for (const q of questions) {
    let vector = cached.get(q.questionId);
    if (!vector) {
      vector = await embedQuery(q.question);
      await putCachedQueryEmbedding(q.questionId, config.embeddingModel, vector);
    }
    const retrieved = await retrieveWithVector(vector);
    const ids = retrieved.map((r) => r.chunk.chunk.id);
    const scores = retrieved.map((r) => r.score);
    const rank = ids.indexOf(q.sourceChunkId);
    const hit = rank !== -1;
    const foundRank = rank === -1 ? null : rank + 1;
    results.push({
      questionId: q.questionId,
      labelId: q.labelId,
      k: config.topK,
      hit,
      foundRank,
      retrievedIds: ids,
      retrievedScores: scores,
    });
    done += 1;
    emit({
      type: "score-result",
      done,
      total: questions.length,
      questionId: q.questionId,
      hit,
      foundRank,
    });
  }

  await insertResults(results);
  return results.length;
}

// Score every question that has no fresh result (new or edited since last score).
export async function scoreUnscoredQuestions(emit: Emit = () => {}): Promise<number> {
  const pending = await questionsNeedingScoring();
  if (pending.length === 0) return 0;
  console.log(`[rag:eval] scoring ${pending.length} question(s) @ k=${config.topK}`);
  return scoreQuestions(pending, emit);
}

// The "Process new chunks" button: generate questions for new chunks, score
// what's unscored, then freeze a comparison snapshot of the current aggregate.
export async function processNewChunks(emit: Emit = () => {}): Promise<{
  generated: number;
  scored: number;
  recall: number | null;
}> {
  const t0 = performance.now();
  const generated = await generateMissingQuestions(emit);
  const scored = await scoreUnscoredQuestions(emit);

  const summary = await getSummary();
  // Only snapshot when something actually changed, so repeated clicks don't
  // pile up identical run rows.
  if (generated > 0 || scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
    });
  }

  console.log(
    `[rag:eval] processNewChunks done: generated=${generated} scored=${scored} ` +
      `recall=${summary.recall ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    generated,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { generated, scored, recall: summary.recall };
}

// The "Re-score all" button: re-run retrieval for EVERY labeled question under the
// active config against the current corpus and freeze a snapshot. Unlike
// processNewChunks this ignores existing results (it inserts fresh rows; history is
// preserved), so recall stays apples-to-apples after the corpus changes — e.g. a newly
// added doc introduces distractors that can push a previously-hit chunk out of the
// top-k. Generation is untouched; this only scores.
export async function rescoreAllQuestions(emit: Emit = () => {}): Promise<{
  scored: number;
  recall: number | null;
}> {
  const t0 = performance.now();
  const questions = await allLabeledQuestions();
  console.log(
    `[rag:eval] re-scoring all ${questions.length} question(s) @ k=${config.topK}`,
  );
  const scored = await scoreQuestions(questions, emit);

  const summary = await getSummary();
  if (scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
    });
  }

  console.log(
    `[rag:eval] rescoreAllQuestions done: scored=${scored} ` +
      `recall=${summary.recall ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    generated: 0,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
  });
  return { scored, recall: summary.recall };
}

// ---------------------------------------------------------------------------
// Re-chunk experiment: an ephemeral per-chunk "what-if".
//
// Re-split ONE labeled chunk at a trial (size, overlap), embed the pieces, and
// re-rank the question against a corpus where that chunk is replaced by its
// sub-chunks. Nothing is persisted — no new chunks, no scores, no config change
// — so the live retrieval index and every other question's score are untouched.
//
// This is a LOCAL APPROXIMATION of a full re-chunk: the chunk's document
// neighbors stay frozen, so the seams between this chunk and its neighbors are
// not re-formed (overlap only moves this chunk's INTERNAL seams). Size is the
// high-signal knob here; read overlap results with that caveat. Methodology
// matches the miss drill-down: exact full-scan rank (see rankWithSubstitutedChunk).
// ---------------------------------------------------------------------------

// One sub-chunk's standing in the experiment ranking.
export type RechunkSubChunk = {
  subIndex: number; // 0-based piece order within the original chunk
  rank: number; // 1-based exact rank in the substituted corpus
  score: number; // cosine similarity to the query
  text: string;
  inTopK: boolean;
};

// One row of the experiment's top-k, flagged when it's one of this chunk's pieces.
export type RechunkRankedChunk = {
  rank: number;
  fileName: string | null;
  position: number | null;
  subIndex: number | null;
  text: string;
  score: number;
  isSubChunk: boolean;
};

// Shared result of both experiment modes (uniform sub-divide and custom-boundary).
// The trial knobs (size/overlap, or boundaries) aren't echoed back — the caller
// already submitted them and renders them itself.
export type RechunkResult = {
  subChunkCount: number;
  k: number;
  hit: boolean; // did any sub-chunk land in the top-k?
  bestSubRank: number | null; // best (lowest) rank across all sub-chunks
  topK: RechunkRankedChunk[];
  subChunks: RechunkSubChunk[];
};

// Core: replace the labeled chunk with `subTexts`, embed those, and exact-rank the
// question against the substituted corpus. Reuses the cached query vector (embeds
// only on a cache miss). Shared by both modes; nothing is persisted.
async function rankExperiment(
  ctx: ExperimentContext,
  subTexts: string[],
): Promise<RechunkResult> {
  const queryVector = ctx.queryVector ?? (await embedQuery(ctx.question));
  const subVectors = await embedTexts(subTexts);

  const k = config.topK;
  const ranked = await rankWithSubstitutedChunk({
    queryVector,
    sourceChunkId: ctx.chunkId,
    subTexts,
    subVectors,
    k,
  });

  const topK: RechunkRankedChunk[] = ranked
    .filter((r) => r.rank <= k)
    .map((r) => ({
      rank: r.rank,
      fileName: r.fileName,
      position: r.position,
      subIndex: r.subIndex,
      text: r.text,
      score: r.score,
      isSubChunk: r.subIndex !== null,
    }));

  const subChunks: RechunkSubChunk[] = ranked
    .filter((r) => r.subIndex !== null)
    .map((r) => ({
      subIndex: r.subIndex as number,
      rank: r.rank,
      score: r.score,
      text: r.text,
      inTopK: r.rank <= k,
    }))
    .sort((a, b) => a.subIndex - b.subIndex);

  const hit = subChunks.some((s) => s.inTopK);
  const bestSubRank =
    subChunks.length > 0 ? Math.min(...subChunks.map((s) => s.rank)) : null;

  return { subChunkCount: subTexts.length, k, hit, bestSubRank, topK, subChunks };
}

// Mode A — uniform sub-divide: split the labeled chunk at a trial (size, overlap)
// and re-rank. Returns null when the question has no label under the active config.
export async function runRechunkExperiment(
  questionId: string,
  size: number,
  overlap: number,
): Promise<RechunkResult | null> {
  const t0 = performance.now();
  const ctx = await getExperimentContext(questionId);
  if (!ctx) return null;

  const subTexts = await splitText(ctx.chunkText, size, overlap);
  const result = await rankExperiment(ctx, subTexts);

  console.log(
    `[rag:eval] rechunk q=${questionId.slice(0, 8)} size=${size} overlap=${overlap}: ` +
      `${result.subChunkCount} sub-chunk(s), hit=${result.hit} ` +
      `bestRank=${result.bestSubRank ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  return result;
}

// Mode B — custom boundaries: replace the labeled chunk with the supplied section
// text(s) (a single hand-reshaped chunk today) and re-rank. Same null contract.
export async function runCustomChunkExperiment(
  questionId: string,
  sections: string[],
): Promise<RechunkResult | null> {
  const t0 = performance.now();
  const ctx = await getExperimentContext(questionId);
  if (!ctx) return null;

  const result = await rankExperiment(ctx, sections);

  console.log(
    `[rag:eval] custom-chunk q=${questionId.slice(0, 8)}: ${sections.length} section(s), ` +
      `hit=${result.hit} bestRank=${result.bestSubRank ?? "n/a"} in ${Math.round(performance.now() - t0)}ms`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Boundary editor: assemble the local window the "resize one custom chunk" mode
// renders. Stitches the labeled chunk + neighbors back into contiguous text (see
// reconstruct.ts), tokenizes it to map token borders to char offsets, and reports
// each chunk's token span so the UI can draw frozen-neighbor bands and the test
// chunk's editable [start, end). Read-only; nothing is persisted.
// ---------------------------------------------------------------------------
export type ChunkWindow = {
  testPosition: number;
  totalChunks: number; // chunks in the doc (so the UI knows the range bounds)
  rangeFrom: number; // first/last chunk position included in this window
  rangeTo: number;
  text: string; // stitched window text
  tokenCount: number;
  offsets: number[]; // length tokenCount+1; char index of each token boundary
  chunks: { position: number; tokenStart: number; tokenEnd: number; frozen: boolean }[];
  exclusive: { tokenStart: number; tokenEnd: number }; // test chunk's exclusive zone
  testDefault: { tokenStart: number; tokenEnd: number }; // the test chunk's own span
};

export async function buildChunkWindow(
  questionId: string,
  fromPos: number,
  toPos: number,
): Promise<ChunkWindow | null> {
  const win = await getChunkWindow(questionId, fromPos, toPos);
  if (!win || win.chunks.length === 0) return null;

  const { text, spans } = stitchChunks(win.chunks);
  const { tokenCount, offsets } = await tokenizeWithOffsets(text);

  // First token boundary at or after a char index (binary search over offsets).
  const charToToken = (charIdx: number): number => {
    let lo = 0;
    let hi = tokenCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] < charIdx) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const chunks = spans.map((s) => ({
    position: s.position,
    tokenStart: charToToken(s.charStart),
    tokenEnd: charToToken(s.charEnd),
    frozen: s.position !== win.testPosition,
  }));

  const test = chunks.find((c) => c.position === win.testPosition)!;
  const prev = chunks.filter((c) => c.position < win.testPosition).at(-1);
  const next = chunks.find((c) => c.position > win.testPosition);

  return {
    testPosition: win.testPosition,
    totalChunks: win.totalChunks,
    rangeFrom: win.chunks[0].position,
    rangeTo: win.chunks[win.chunks.length - 1].position,
    text,
    tokenCount,
    offsets,
    chunks,
    // Tokens covered ONLY by the test chunk: between the previous neighbor's end
    // and the next neighbor's start. Shrinking inside this zone leaves a real gap.
    exclusive: {
      tokenStart: prev ? prev.tokenEnd : 0,
      tokenEnd: next ? next.tokenStart : tokenCount,
    },
    testDefault: { tokenStart: test.tokenStart, tokenEnd: test.tokenEnd },
  };
}

// ---------------------------------------------------------------------------
// "Try a different model" experiment: an ephemeral per-chunk model A/B.
//
// Re-rank ONE labeled chunk's questions against a small CANDIDATE POOL — the
// chunk itself, the top-k chunks its questions already retrieved, and any corpus
// chunks the user hand-picked — all re-embedded under an ALTERNATE model. For
// each question we cosine-rank the ground-truth chunk within the pool and check
// the top-k. Nothing touches the live index; results are ephemeral unless the
// user saves a snapshot (eval_model_trials).
//
// This is a LOCAL APPROXIMATION: the new-model rank is WITHIN the pool, not the
// full corpus, and it's compared against the question's STORED full-corpus
// result (the baseline). The pool is far smaller than the corpus, so read a
// rescued miss as "this model re-orders the candidates better," not as true
// recall. We re-embed in memory and rank by cosine (not pgvector), so the trial
// is decoupled from the chunks_<model>_<dim> tables and any output dimension
// works.
// ---------------------------------------------------------------------------

// What the trial UI needs to set up a run: the chunk, its questions (with the
// stored baseline), the auto pool (top-k union), and the rest of the corpus to
// pick from — plus the models on offer and any saved trials for this chunk.
export type ModelTrialContext = {
  models: { id: string; label: string }[];
  baselineModel: string;
  k: number;
  chunk: { chunkId: string; fileName: string; position: number | null; text: string };
  questions: {
    questionId: string;
    question: string;
    storedHit: boolean | null;
    storedRank: number | null;
  }[];
  autoPool: PoolChunk[]; // top-k union across the chunk's questions, minus the chunk
  restCorpus: CorpusChunkListItem[]; // everything else, for the manual picker
  savedTrials: SavedModelTrial[];
};

// Result of one trial run, returned to the client (ephemeral until saved).
export type ModelTrialResult = {
  model: string;
  baselineModel: string;
  k: number;
  poolSize: number;
  pool: PoolChunk[]; // the candidate pool, resolved — for the tooltip + top-k labels
  questionCount: number;
  hitCount: number; // hits under the trial model (in-pool)
  storedHitCount: number; // baseline hits (stored full-corpus result)
  recall: number | null;
  questions: TrialQuestionOutcome[];
};

const uniq = (ids: string[]): string[] => [...new Set(ids)];

// (cosine + the session embedding cache now live in lib/rag/embedCache.ts,
// shared with the graded-nDCG ranking builder.)

// Assemble the context the trial UI renders. Null when the chunk isn't part of
// the active config's corpus (stale id / wrong config).
export async function getModelTrialContext(
  chunkId: string,
): Promise<ModelTrialContext | null> {
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return null;

  const questions = await getModelTrialQuestions(chunkId);
  // Auto pool = the distractors the chunk's questions already surfaced (the chunk
  // itself is always added at run time, so drop it here to avoid a duplicate).
  const autoIds = uniq(questions.flatMap((q) => q.retrievedIds)).filter((id) => id !== chunkId);

  const [autoPool, restCorpus, savedTrials] = await Promise.all([
    getChunksByIds(autoIds),
    getCorpusChunkList([chunkId, ...autoIds]),
    listModelTrials(chunkId),
  ]);

  return {
    models: altEmbeddingModels,
    baselineModel: config.embeddingModel,
    k: config.topK,
    chunk: {
      chunkId: chunk.chunkId,
      fileName: chunk.fileName,
      position: chunk.position,
      text: chunk.text,
    },
    questions: questions.map((q) => ({
      questionId: q.questionId,
      question: q.question,
      storedHit: q.storedHit,
      storedRank: q.storedRank,
    })),
    autoPool,
    restCorpus,
    savedTrials,
  };
}

// Run the trial: embed the pool + each question under `model`, cosine-rank the
// chunk within the pool per question, and (optionally) persist the snapshot.
// Returns null when the chunk has no questions / isn't under the active config;
// throws on an unknown model.
export async function runModelTrial(
  chunkId: string,
  model: string,
  poolChunkIds: string[],
  save: boolean,
): Promise<{ result: ModelTrialResult; savedTrial: SavedModelTrial | null } | null> {
  if (!altEmbeddingModels.some((m) => m.id === model)) {
    throw new Error(`Unknown model "${model}".`);
  }

  const t0 = performance.now();
  const chunk = await getModelTrialChunk(chunkId);
  if (!chunk) return null;
  const questions = await getModelTrialQuestions(chunkId);
  if (questions.length === 0) return null;

  // The chunk is always in the pool (it's the ground truth we're ranking).
  const poolIds = uniq([chunkId, ...poolChunkIds]);
  const poolChunks = await getChunksByIds(poolIds);

  const poolVectors = await embedDocsCached(poolChunks.map((c) => c.text), model);
  const vecById = new Map(poolChunks.map((c, i) => [c.chunkId, poolVectors[i]]));
  const testVec = vecById.get(chunkId);
  if (!testVec) return null; // chunk dropped out of the active corpus mid-run

  const k = config.topK;
  const questionsOut: TrialQuestionOutcome[] = [];
  for (const q of questions) {
    const qVec = await embedQueryCached(q.question, model);
    const scored = poolChunks.map((c) => ({
      id: c.chunkId,
      sim: cosine(qVec, vecById.get(c.chunkId)!),
    }));
    scored.sort((a, b) => b.sim - a.sim);
    const newRank = scored.findIndex((s) => s.id === chunkId) + 1; // 1-based
    const topPool: TrialPoolHit[] = scored.slice(0, k).map((s, i) => ({
      chunkId: s.id,
      rank: i + 1,
      score: s.sim,
      isExpected: s.id === chunkId,
    }));
    questionsOut.push({
      questionId: q.questionId,
      question: q.question,
      storedHit: q.storedHit,
      storedRank: q.storedRank,
      newHit: newRank >= 1 && newRank <= k,
      newRank,
      newScore: cosine(qVec, testVec),
      topPool,
    });
  }

  const hitCount = questionsOut.filter((o) => o.newHit).length;
  const storedHitCount = questionsOut.filter((o) => o.storedHit === true).length;
  const result: ModelTrialResult = {
    model,
    baselineModel: config.embeddingModel,
    k,
    poolSize: poolChunks.length,
    pool: poolChunks,
    questionCount: questionsOut.length,
    hitCount,
    storedHitCount,
    recall: questionsOut.length > 0 ? hitCount / questionsOut.length : null,
    questions: questionsOut,
  };

  let savedTrial: SavedModelTrial | null = null;
  if (save) {
    const ins = await insertModelTrial({
      sourceChunkId: chunkId,
      documentEmbeddingId: chunk.documentEmbeddingId,
      baselineModel: config.embeddingModel,
      trialModel: model,
      k,
      poolChunkIds: poolIds,
      questionCount: questionsOut.length,
      hitCount,
      storedHitCount,
      results: questionsOut,
    });
    savedTrial = {
      id: ins.id,
      baselineModel: config.embeddingModel,
      trialModel: model,
      k,
      poolSize: poolIds.length,
      pool: poolChunks,
      questionCount: questionsOut.length,
      hitCount,
      storedHitCount,
      results: questionsOut,
      createdAt: ins.createdAt,
    };
  }

  console.log(
    `[rag:eval] model-trial chunk=${chunkId.slice(0, 8)} model=${model} ` +
      `pool=${poolChunks.length} q=${questionsOut.length} hits=${hitCount}/${questionsOut.length} ` +
      `${save ? "(saved) " : ""}in ${Math.round(performance.now() - t0)}ms`,
  );
  return { result, savedTrial };
}
