// BATCH JOB: cache_pair_generation — routed by keyModelSweep.generateModel's own
// provider, which is an Anthropic id today.
//
// Synthesizes the generated half of the cache-key eval pair set — one
// independent request per eval question, so the whole bank goes out at once at
// the −50% batch price. The one-off cost the sweep is built on
// (docs/semantic-cache-key-model-plan.md, Phase 2).
//
// Shares pairRequestParams / parsePairs / pairsFrom with the inline path
// (semanticCachePairs.generatePairs), so prompt, parse and LABELLING can never
// drift between them — which matters more here than usual: the labels are
// ANSWER-LEVEL by construction, and a divergence would silently poison the
// pooled pair set with question-level labels.
//
// apply is IDEMPOTENT: inserts go through insertPairs, whose canonical
// (hash_a, hash_b) unique key + on-conflict-do-nothing makes a re-poll or retry
// a no-op rather than a duplicate.
import { config } from "@/lib/config";
import {
  insertPairs,
  pairRequestParams,
  pairsFrom,
  parsePairs,
  questionsNeedingPairs,
} from "@/lib/rag/semanticCachePairs";
import { bankLlmBatchSaving } from "@/lib/batch/savings";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { batchCustomId, type BatchResultRow } from "@/lib/batch/types";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";

export type PairGenScope = { limit?: number };

type Origin = { customId: string; questionId: string; question: string };
type PairGenInput = { generatedBy: string; origins: Origin[] };

// Parse-body shape parsePairs accepts (an Anthropic Message's `content`).
type MessageBody = { content: Array<{ type: string; text?: string }>; stop_reason?: string | null };

// The whole bank by default — that's the point of using the batch API for this
// rather than the inline path, which is capped to survive a request wall-clock.
const BATCH_MAX_QUESTIONS = 5000;

export const pairGenerationHandler: JobHandler = {
  async build(scope) {
    const { limit } = (scope ?? {}) as PairGenScope;
    const gaps = await questionsNeedingPairs(Math.min(limit ?? BATCH_MAX_QUESTIONS, BATCH_MAX_QUESTIONS));
    if (gaps.length === 0) return null;

    const model = config.semanticCache.keyModelSweep.generateModel;
    const counts = config.semanticCache.keyModelSweep.pairsPerQuestion;
    // Index-prefixed so custom_ids stay unique even if the gap query ever
    // returns a question twice.
    const origins: Origin[] = gaps.map((g, i) => ({
      customId: batchCustomId(i, g.questionId),
      questionId: g.questionId,
      question: g.question,
    }));
    const requests = gaps.map((g, i) => ({
      customId: origins[i].customId,
      params: pairRequestParams(g.question, g.expectedAnswer, counts, model),
    }));
    return {
      requests,
      // NOT the config's llmModel — this job runs on its own global
      // generateModel (above), and the whole point of having build() name the
      // provider is that this difference can't be lost at the call site. An
      // Anthropic id today, so an Anthropic batch; changing that setting to a
      // gpt-* id is all it would take to move this leg, with no other edit.
      provider: llmProviderOf(model),
      input: { generatedBy: model, origins } satisfies PairGenInput,
      submitMeta: {},
    } satisfies BuiltBatch;
  },

  async apply(input, results) {
    const { generatedBy, origins } = input as PairGenInput;
    const byId = new Map<string, BatchResultRow>(results.map((r) => [r.customId, r]));
    let applied = 0;
    for (const origin of origins) {
      const res = byId.get(origin.customId);
      if (!res || res.outcome !== "succeeded" || !res.body) continue;
      // The ORIGIN TEXT comes from `input`, not the response: it's one half of
      // every pair, and rebuilding it from the model's output would let a
      // hallucinated restatement become the stored text_a.
      const pairs = pairsFrom(origin.question, parsePairs(res.body as MessageBody));
      if (pairs.length === 0) continue;
      applied += await insertPairs(origin.questionId, pairs, generatedBy);
    }
    await bankLlmBatchSaving(results);
    return applied;
  },
};
