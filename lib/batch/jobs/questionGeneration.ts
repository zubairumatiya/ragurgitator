// ---------------------------------------------------------------------------
// BATCH JOB: question_generation (Anthropic or OpenAI — whichever serves the
// config's llmModel; both discount batch work 50%).
//
// The ideal batch shape — one independent request per (chunk, difficulty) gap,
// dozens-to-thousands at once. Shares the exact prompt + parse with the inline
// generator via questionRequestParams / parseQuestions (lib/rag/eval.ts), so the
// two paths can never drift.
//
// One request per QUESTION asked for: a chunk that Bulk actions wants two easy
// questions for contributes two independent requests.
//
// apply is IDEMPOTENT: before inserting it re-counts what the (chunk, difficulty)
// pair has against the target the batch was built for (the same comparison
// chunksNeedingQuestionsByDifficulty made at build time), so a re-poll, retry, or
// a competing inline generation can't push a chunk past its target.
//
// RESULTS ARE BANKED, NOT SERVED. apply writes every question it lands into
// question_cache (0055) so a later config can pick it up for free, but build
// never serves from that cache: reuse is a deliberate act — "Bulk actions → Add
// question → Add cached" — so a batch submitted here buys exactly what was
// asked for. Clear the cache first if you want the free half; the button is
// idempotent and takes it without spending anything.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import type { Difficulty } from "@/lib/rag/eval";
import { parseQuestions, questionRequestParams, QUESTION_PROMPT_VERSION } from "@/lib/rag/eval";
import { bankedSlotCounts, bankQuestions, hashChunkText } from "@/lib/rag/questionCache";
import { chunksNeedingQuestionsByDifficulty, insertQuestionWithLabel } from "@/lib/rag/evalStore";
import { bankLlmBatchSaving } from "@/lib/batch/savings";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { batchCustomId, type BatchResultRow } from "@/lib/batch/types";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";

export type QuestionGenScope = {
  difficulties: Difficulty[];
  documentIds?: string[];
  // Questions per chunk per difficulty, aligned with `difficulties` (default 1).
  counts?: number[];
  // The Add panel's "Top up" checkbox. Must ride along on the job payload: a
  // batched Add that lost it would build the wrong gap set entirely — filling
  // chunks TO N instead of adding N to each, or the reverse.
  topUp?: boolean;
};

type Gap = {
  customId: string;
  chunkId: string;
  documentId: string;
  documentEmbeddingId: string;
  difficulty: string;
  // How many questions this (chunk, difficulty) pair should end up with — the
  // ceiling apply refuses to insert past. Computed at build time as
  // have + needed, so it is right in both top-up and absolute mode.
  target: number;
  // sha256 of the chunk text, so apply can bank the result into question_cache
  // without carrying every chunk's full text on the job row's jsonb.
  textHash: string;
};
type QuestionGenInput = { generatorModel: string; gaps: Gap[] };

// Parse-body shape parseQuestions accepts (an Anthropic Message's `content`).
type MessageBody = { content: Array<{ type: string; text?: string }>; stop_reason?: string | null };

// Room left for this gap right now: how far the pair is below the target the
// batch was built for. Re-checked per insert, so slots already filled inline (or
// by an earlier apply of the same batch) are skipped instead of duplicated.
async function gapStillOpen(gap: Gap): Promise<boolean> {
  const [row] = await sql<{ have: number }[]>`
    select count(*)::int as have
    from eval_labels l
    join eval_questions q on q.id = l.eval_question_id
    where l.source_chunk_id = ${gap.chunkId}
      and l.document_embedding_id = ${gap.documentEmbeddingId}
      and q.difficulty = ${gap.difficulty}
  `;
  return (row?.have ?? 0) < (gap.target ?? 1);
}

export const questionGenerationHandler: JobHandler = {
  async build(scope) {
    const { difficulties, documentIds, counts, topUp } = scope as QuestionGenScope;
    if (!difficulties || difficulties.length === 0) return null;
    // No cache serve here: reuse is an explicit Bulk-actions button ("Add
    // cached"), so a batch submitted from this path buys exactly what was asked
    // for. Results still get BANKED in apply below.
    const gaps = await chunksNeedingQuestionsByDifficulty(
      difficulties,
      documentIds,
      counts,
      topUp ?? false,
    );
    if (gaps.length === 0) return null;

    const model = activeConfig().llmModel;
    const built: Gap[] = [];
    const requests: BuiltBatch["requests"] = [];
    for (const g of gaps) {
      // One request per missing question, so a chunk short by two gets two
      // independent generations rather than one asking for a pair.
      for (let slot = 0; slot < g.needed; slot += 1) {
        // Index-prefixed so custom_ids stay unique across chunks AND slots.
        const customId = batchCustomId(built.length, g.chunkId, g.difficulty);
        built.push({
          customId,
          chunkId: g.chunkId,
          documentId: g.documentId,
          documentEmbeddingId: g.documentEmbeddingId,
          difficulty: g.difficulty,
          // The ceiling apply refuses to insert past: what the pair held at
          // build time plus what this batch was built to add. In top-up mode
          // that is exactly the requested target; in absolute mode it is "N more
          // than these", which a bare target could not express.
          target: g.have + g.needed,
          textHash: hashChunkText(g.text),
        });
        requests.push({
          customId,
          params: questionRequestParams(g.text, 1, g.difficulty as Difficulty, model),
        });
      }
    }
    const input: QuestionGenInput = { generatorModel: model, gaps: built };
    // Same model as the inline generator, so the same provider — a config on a
    // gpt-* model batches through OpenAI rather than submitting an OpenAI id to
    // Anthropic's Message Batches API.
    return {
      requests,
      provider: llmProviderOf(model),
      input,
      submitMeta: {},
    } satisfies BuiltBatch;
  },

  async apply(input, results) {
    const { generatorModel, gaps } = input as QuestionGenInput;
    const byId = new Map<string, BatchResultRow>(results.map((r) => [r.customId, r]));
    let applied = 0;
    // Grouped by passage so the cache write is one counts query plus one insert,
    // rather than a round trip per result.
    const toBank = new Map<
      string,
      {
        textHash: string;
        difficulty: string;
        questions: { question: string; expectedAnswer: string | null }[];
        inputTokens: number;
        outputTokens: number;
      }
    >();
    for (const gap of gaps) {
      const res = byId.get(gap.customId);
      if (!res || res.outcome !== "succeeded" || !res.body) continue;
      const [q] = parseQuestions(res.body as MessageBody, 1);
      if (!q || !q.question.trim()) continue;
      if (!(await gapStillOpen(gap))) continue; // idempotency guard
      const question = q.question.trim();
      const expectedAnswer = q.expected_answer?.trim() || null;
      await insertQuestionWithLabel({
        documentId: gap.documentId,
        documentEmbeddingId: gap.documentEmbeddingId,
        sourceChunkId: gap.chunkId,
        question,
        expectedAnswer,
        generatorModel,
        difficulty: gap.difficulty,
      });
      applied += 1;

      // Bank it, so a batch-generated corpus feeds the cache exactly as an
      // inline one does — otherwise which path you happened to use would
      // silently decide whether the NEXT config pays.
      const key = `${gap.textHash} ${gap.difficulty}`;
      const entry = toBank.get(key) ?? {
        textHash: gap.textHash,
        difficulty: gap.difficulty,
        questions: [],
        inputTokens: 0,
        outputTokens: 0,
      };
      entry.questions.push({ question, expectedAnswer });
      const usage = (res.body as { usage?: { input_tokens?: number; output_tokens?: number } })
        .usage;
      entry.inputTokens += usage?.input_tokens ?? 0;
      entry.outputTokens += usage?.output_tokens ?? 0;
      toBank.set(key, entry);
    }

    if (toBank.size > 0) {
      const entries = [...toBank.values()];
      // Gaps carry a textHash only from builds that postdate the cache; an older
      // job row replayed after deploy has undefined and is skipped rather than
      // banked under the string "undefined".
      const bankable = entries.filter((e) => typeof e.textHash === "string" && e.textHash);
      const counts = await bankedSlotCounts(
        generatorModel,
        QUESTION_PROMPT_VERSION,
        bankable.map((e) => ({ textHash: e.textHash, difficulty: e.difficulty })),
      );
      for (const e of bankable) {
        await bankQuestions({
          textHash: e.textHash,
          difficulty: e.difficulty,
          model: generatorModel,
          promptVersion: QUESTION_PROMPT_VERSION,
          startSlot: counts.get(`${e.textHash} ${e.difficulty}`) ?? 0,
          questions: e.questions,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
        });
      }
    }
    await bankLlmBatchSaving(results);
    return applied;
  },
};
