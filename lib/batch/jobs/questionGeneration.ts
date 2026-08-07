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
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import type { Difficulty } from "@/lib/rag/eval";
import { parseQuestions, questionRequestParams } from "@/lib/rag/eval";
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
};

type Gap = {
  customId: string;
  chunkId: string;
  documentId: string;
  documentEmbeddingId: string;
  difficulty: string;
  // How many questions this (chunk, difficulty) pair should end up with — the
  // ceiling apply refuses to insert past.
  target: number;
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
    const { difficulties, documentIds, counts } = scope as QuestionGenScope;
    if (!difficulties || difficulties.length === 0) return null;
    const gaps = await chunksNeedingQuestionsByDifficulty(difficulties, documentIds, counts);
    if (gaps.length === 0) return null;

    const model = activeConfig().llmModel;
    // The absolute per-(chunk, difficulty) ceiling this batch was built for —
    // apply re-checks against it, so a slot filled meanwhile is dropped.
    const targetFor = (difficulty: string) =>
      Math.max(1, Math.trunc(counts?.[difficulties.indexOf(difficulty as Difficulty)] ?? 1));
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
          target: targetFor(g.difficulty),
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
    for (const gap of gaps) {
      const res = byId.get(gap.customId);
      if (!res || res.outcome !== "succeeded" || !res.body) continue;
      const [q] = parseQuestions(res.body as MessageBody, 1);
      if (!q || !q.question.trim()) continue;
      if (!(await gapStillOpen(gap))) continue; // idempotency guard
      await insertQuestionWithLabel({
        documentId: gap.documentId,
        documentEmbeddingId: gap.documentEmbeddingId,
        sourceChunkId: gap.chunkId,
        question: q.question.trim(),
        expectedAnswer: q.expected_answer?.trim() || null,
        generatorModel,
        difficulty: gap.difficulty,
      });
      applied += 1;
    }
    await bankLlmBatchSaving(results);
    return applied;
  },
};
