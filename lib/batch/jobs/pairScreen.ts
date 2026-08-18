// BATCH JOB: cache_pair_screen — the batch path's judge screen over generated
// eval pairs, routed by the shadow judge's own boundary model.
//
// WHY THIS EXISTS. The inline generator screens every pair as it writes it
// (generatePairs → screenPair): F3 measured the generator at 100% on paraphrases
// but 80% on HARD NEGATIVES, and the sweep uses a mislabelled negative to punish
// exactly the models that score it correctly. The batch generator could not do
// the same thing in-line — one sequential judge call per pair inside a
// batch-apply step is thousands of calls in a slice not built for them — so
// batch-generated pairs used to land unscreened and wait for a hand-run F3 audit.
//
// This is that audit, as a second batch. It costs the same −50% as the generation
// batch it follows, runs on the provider's clock rather than a job slice, and is
// CHAINED from pairGeneration.apply (registry's `chain` hook), so a bulk
// generation now screens itself with no second click.
//
// ONE DIFFERENCE FROM THE INLINE SCREEN, and it is not a bug. Inline, a
// contradicted pair is never stored. Here the row already exists by the time a
// verdict arrives, so a contradiction is recorded as a verdict and the row is
// QUARANTINED by listPairs' existing filter instead of deleted. Same effect on
// the sweep — the pair stops being scored — but the row stays visible and
// countable (pairStats.quarantined), and an agreeing verdict is banked on the
// row exactly as the inline screen banks it, so a later `npm run f3 -- judge`
// has nothing left to pay for.
//
// FAILS OPEN like the inline screen: an errored request, an unparseable reply, or
// an origin question with no stored answer leaves the pair UNJUDGED, which is
// where it already was. A screen that guesses is worse than one that skips.
//
// apply is IDEMPOTENT: setPairVerdict is a plain update by id, and it refuses to
// overwrite a HUMAN verdict, so a re-poll re-writes the same values and an
// adjudicated row survives.
import { config } from "@/lib/config";
import { judgeRequestParams, parseJudgeReply } from "@/lib/rag/semanticCacheCalibration";
import {
  setPairVerdict,
  unscreenedPairs,
  type PairLabel,
} from "@/lib/rag/semanticCachePairs";
import { bankLlmBatchSaving } from "@/lib/batch/savings";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { batchCustomId, type BatchResultRow } from "@/lib/batch/types";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";

export type PairScreenScope = { limit?: number };

type Screened = { customId: string; pairId: string; label: PairLabel };
type PairScreenInput = { judgeModel: string; pairs: Screened[] };

type MessageBody = { content: Array<{ type: string; text?: string }> };

// The whole unjudged set by default — the point of batching this rather than
// running the inline audit is that a whole-bank generation can be screened in one
// submission.
const BATCH_MAX_PAIRS = 5000;

export const pairScreenHandler: JobHandler = {
  // One open screen at a time: build takes every unjudged pair, so a second
  // submission before the first returns would re-judge the same rows.
  singleton: true,

  async build(scope) {
    const { limit } = (scope ?? {}) as PairScreenScope;
    const pending = await unscreenedPairs(Math.min(limit ?? BATCH_MAX_PAIRS, BATCH_MAX_PAIRS));
    if (pending.length === 0) return null;

    // The judge the shadow log's boundary pass uses — the model F3 audited this
    // pair set with, and the one the inline screen uses. Deliberately not its own
    // setting: a screen run under a different judge than the audit would disagree
    // with the quarantine and neither number would mean anything.
    const model = config.semanticCache.judgeBoundaryModel;
    const pairs: Screened[] = pending.map((p, i) => ({
      customId: batchCustomId(i, p.id),
      pairId: p.id,
      label: p.label,
    }));
    const requests = pending.map((p, i) => ({
      customId: pairs[i].customId,
      // DIRECTION is the one F3 established and the inline screen uses: the
      // VARIANT is the new question and the ORIGIN is the stored one, which is
      // the direction the cache actually runs in. Roles come from
      // unscreenedPairs, which resolves them against eval_questions — text_a is
      // not reliably the origin.
      params: judgeRequestParams(model, p.variantText, p.originText, p.expectedAnswer),
    }));
    return {
      requests,
      provider: llmProviderOf(model),
      input: { judgeModel: model, pairs } satisfies PairScreenInput,
      submitMeta: {},
    } satisfies BuiltBatch;
  },

  async apply(input, results) {
    const { judgeModel, pairs } = input as PairScreenInput;
    const byId = new Map<string, BatchResultRow>(results.map((r) => [r.customId, r]));
    let applied = 0;
    for (const pair of pairs) {
      const res = byId.get(pair.customId);
      if (!res || res.outcome !== "succeeded" || !res.body) continue;
      const { verdict, reason } = parseJudgeReply(res.body as MessageBody);
      if (verdict === null) continue;
      await setPairVerdict(pair.pairId, verdict, "llm", judgeModel, reason);
      // Counted: the applied number is verdicts WRITTEN, agreeing and
      // contradicting alike. A contradicting one is the gate working, not a
      // failure, and the panel reads the quarantine count for that split.
      applied++;
    }
    await bankLlmBatchSaving(results);
    return applied;
  },
};
