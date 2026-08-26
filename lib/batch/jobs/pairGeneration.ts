// BATCH JOB: cache_pair_generation — routed by keyModelSweep.generateModel's own
// provider, which is an Anthropic id today.
//
// Synthesizes the generated half of the cache-key eval pair set — one independent
// request per eval question, so the whole bank goes out at once at the −50% batch
// price. The one-off cost the sweep is built on.
//
// Shares pairRequestParams / parsePairs / pairsFrom with the inline path, so prompt,
// parse and LABELLING can never drift — which matters more here than usual: the
// labels are ANSWER-LEVEL by construction, and a divergence would silently poison
// the pooled pair set with question-level labels.
//
// SCREENED BY A SECOND BATCH, not in-line. generatePairs judges every pair
// against the shadow rubric before storing it (F3 measured the generator at 80%
// on hard negatives); doing the same inside this apply() would mean one
// sequential judge call per pair — thousands of them for a whole-bank run, in a
// job slice that is not built for it. So apply() CHAINS a cache_pair_screen
// batch instead: same rubric, same judge model, same −50%, on the provider's
// clock. A contradicted pair is quarantined rather than dropped (the row already
// exists by then); see lib/batch/jobs/pairScreen.ts.
//
// apply is IDEMPOTENT: inserts go through insertPairs, whose canonical
// (hash_a, hash_b) unique key + on-conflict-do-nothing makes a re-poll or retry a
// no-op rather than a duplicate.
import { config } from "@/lib/config";
import {
  insertPairs,
  pairRequestParams,
  pairsFrom,
  parsePairs,
  questionsNeedingPairs,
} from "@/lib/rag/semanticCachePairs";
import { triggerProbeReplay } from "@/lib/rag/probeReplayTrigger";
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
    // The batch path's half of Phase 3 (docs/probe-replay-plan.md). This is the
    // moment the batch's pairs exist, so it is this path's "end of generation" —
    // the inline path fires from its route for the same reason.
    //
    // NOT in chain(), which can only ask for another provider batch; a probe run
    // is a background job, a different mechanism. And AFTER bankLlmBatchSaving,
    // so an unexpected failure in the trigger cannot cost the savings ledger the
    // discount this batch actually earned — though triggerProbeReplay swallows
    // its own errors, since orchestrator.applyJob would otherwise mark a batch
    // whose rows are already in the table as failed.
    if (applied > 0) await triggerProbeReplay();
    return applied;
  },

  // Screen what we just wrote. The scope is deliberately EMPTY rather than the
  // ids from this batch: the screen's build selects every unjudged pair, so one
  // chained run also picks up anything an earlier unscreened batch left behind.
  // Nothing to screen returns null from its build and no job row is created.
  async chain(_input, applied) {
    return applied > 0 ? { kind: "cache_pair_screen", scope: {} } : null;
  },
};
