// CAPTURING THE SIMILARITY MATRIX — phase 2 of docs/demo-cache-replay-plan.md.
//
// The publish runs one sweep whose leaderboard nobody keeps, purely to record the
// cosines underneath it. That is the whole trick: `scoreModel` embeds every pair
// text, cosines each pair, and hands a plain `{sim, label}[]` to
// `calibrateFromJudged` and `auc` — so a guest who has the cosines can re-run the
// real arithmetic over the first `n` of them and print, exactly, what a real
// sweep at that size would have printed.
//
// WHY THIS SWEEP INCLUDES THE QUARANTINED PAIRS AND THE PUBLISHED ONE DOES NOT.
// F3 proved 15 generated pairs mislabelled and the sweep drops them; the demo's
// "Screen pairs" button is what performs that drop, so a visitor has to be able
// to see the pool BEFORE it happens. An unscreened pair is scored under the
// generator's label — that is what makes screening move the numbers — so those
// pairs need real cosines too, and they only exist in a run that pooled them.
// They are FLAGGED here rather than filtered, and the reader subtracts them once
// the visitor screens: at full `n`, screened, the replayed leaderboard is the
// master's own sweep row for row.
//
// SO THE PUBLISH RUNS THE SWEEP TWICE, and it is worth being plain about the
// cost. Both runs go through embedQueryCached, which is content-addressed, so
// the second buys no vector the first already banked — the extra spend is the
// ~15 quarantined pairs' texts under each candidate, and the extra time is
// cache reads. Run this one FIRST and the published sweep that follows is
// entirely warm. The alternative — deriving the published result by subsetting
// this run — would route the operator's own leaderboard through the demo's code
// path, and the demo is not allowed to change what the app measures.
import "server-only";

import { config } from "@/lib/config";
import {
  matrixBytes,
  packMatrix,
  pairIdentity,
  type ReplayMatrix,
  type ReplayPair,
} from "@/lib/demo/replayCore";
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import { pairKey } from "@/lib/rag/keyModelSweepCore";
import { runKeyModelSweep, type SweepPair } from "@/lib/rag/keyModelSweep";
import type { EffectiveAcceptTarget } from "@/lib/rag/semanticCache";
import { quarantinedPairs, type PairLabel } from "@/lib/rag/semanticCachePairs";

export type MatrixCapture = {
  matrix: ReplayMatrix;
  bytes: number;
  // Reported rather than recomputed by the caller: the publish prints these, and
  // a number the script derived itself could disagree with what was banked.
  scoredModels: number;
  quarantined: number;
};

// Run the sweep in the CALLER's scope — this is an ordinary user- and
// config-scoped call, and scripts/demo-snapshot wraps it in the master's — and
// keep the cosines rather than the leaderboard.
export async function captureReplayMatrix(
  targetSource: EffectiveAcceptTarget,
  candidates: string[] = [...config.semanticCache.keyModelSweep.candidates],
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<MatrixCapture> {
  // The quarantine is a property of the pair table, not of the pooled set —
  // poolPairs takes it as a separate argument and `includeQuarantined` puts those
  // rows back without marking them — so the flag has to be re-derived here,
  // through the same unordered key poolPairs deduped on.
  const quarantinedKeys = new Set((await quarantinedPairs()).map((p) => pairKey(p.textA, p.textB)));

  let pooled: SweepPair[] = [];
  const scored = new Map<string, { sim: number; label: PairLabel }[]>();
  await runKeyModelSweep(targetSource, candidates, shouldStop, {
    includeQuarantined: true,
    observe: {
      onPairs: (pairs) => {
        pooled = pairs;
      },
      onScored: (model, s) => {
        scored.set(model, s);
      },
    },
  });

  const pairs: ReplayPair[] = pooled.map((p) => ({
    hash: pairIdentity(p.textA, p.textB),
    label: p.label,
    source: p.source,
    ...(p.origin ? { origin: p.origin } : {}),
    difficulty: p.difficulty,
    // A shadow row is never quarantined — the quarantine is a verdict on a
    // GENERATED pair's label — but the key test is written against the pooled
    // row rather than its source, because poolPairs can hand a generated pair's
    // key to a traffic row that outranked it, and that row is not quarantined
    // either. Asking the key keeps those two facts one fact.
    quarantined: p.source === "generated" && quarantinedKeys.has(pairKey(p.textA, p.textB)),
  }));

  // Aligned to `candidates`, not to what scored: a model the sweep could not
  // reach is banked as null so that the reader can say "not scored" rather than
  // "scored zero", which is the same distinction the leaderboard's `available`
  // flag draws. THE TEXTS STOP HERE — nothing below this line can be turned back
  // into a question, which is why the demo can ship the matrix at all.
  const matrix = packMatrix({
    models: candidates,
    pairs,
    sims: candidates.map((m) => scored.get(m)?.map((s) => s.sim) ?? null),
    target: targetSource.target,
    minSamples: config.semanticCache.minCalibrationSamples,
  });

  return {
    matrix,
    bytes: matrixBytes(matrix),
    scoredModels: candidates.filter((m) => scored.has(m)).length,
    quarantined: pairs.filter((p) => p.quarantined).length,
  };
}
