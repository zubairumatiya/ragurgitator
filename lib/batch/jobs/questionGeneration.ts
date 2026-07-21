// ---------------------------------------------------------------------------
// BATCH JOB: question_generation (Anthropic).
//
// The ideal batch shape — one independent request per (chunk, difficulty) gap,
// dozens-to-thousands at once. Shares the exact prompt + parse with the inline
// generator via questionRequestParams / parseQuestions (lib/rag/eval.ts), so the
// two paths can never drift.
//
// apply is IDEMPOTENT: before inserting it re-checks the gap is still open (same
// NOT-EXISTS that chunksNeedingQuestionsByDifficulty used at build time), so a
// re-poll, retry, or a competing inline generation can't create duplicates.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import type { Difficulty } from "@/lib/rag/eval";
import { parseQuestions, questionRequestParams } from "@/lib/rag/eval";
import { chunksNeedingQuestionsByDifficulty, insertQuestionWithLabel } from "@/lib/rag/evalStore";
import type { BatchResultRow } from "@/lib/batch/types";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";

export type QuestionGenScope = { difficulties: Difficulty[]; documentIds?: string[] };

type Gap = {
  customId: string;
  chunkId: string;
  documentId: string;
  documentEmbeddingId: string;
  difficulty: string;
};
type QuestionGenInput = { generatorModel: string; gaps: Gap[] };

// Parse-body shape parseQuestions accepts (an Anthropic Message's `content`).
type MessageBody = { content: Array<{ type: string; text?: string }>; stop_reason?: string | null };

async function gapStillOpen(gap: Gap): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one
    from eval_labels l
    join eval_questions q on q.id = l.eval_question_id
    where l.source_chunk_id = ${gap.chunkId}
      and l.document_embedding_id = ${gap.documentEmbeddingId}
      and q.difficulty = ${gap.difficulty}
    limit 1
  `;
  return rows.length === 0;
}

export const questionGenerationHandler: JobHandler = {
  provider: "anthropic",

  async build(scope) {
    const { difficulties, documentIds } = scope as QuestionGenScope;
    if (!difficulties || difficulties.length === 0) return null;
    const gaps = await chunksNeedingQuestionsByDifficulty(difficulties, documentIds);
    if (gaps.length === 0) return null;

    const model = activeConfig().llmModel;
    const built: Gap[] = gaps.map((g, i) => ({
      // Index-prefixed so custom_ids stay unique even if a chunk appears twice.
      customId: `${i}:${g.chunkId}:${g.difficulty}`,
      chunkId: g.chunkId,
      documentId: g.documentId,
      documentEmbeddingId: g.documentEmbeddingId,
      difficulty: g.difficulty,
    }));
    const requests = gaps.map((g, i) => ({
      customId: built[i].customId,
      params: questionRequestParams(g.text, 1, g.difficulty as Difficulty, model),
    }));
    const input: QuestionGenInput = { generatorModel: model, gaps: built };
    return { requests, input, submitMeta: {} } satisfies BuiltBatch;
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
    return applied;
  },
};
