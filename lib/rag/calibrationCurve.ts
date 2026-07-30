// ---------------------------------------------------------------------------
// SEMANTIC CACHE — choosing τ from a calibration curve. Phase 4 of
// docs/semantic-cache-key-model-plan.md.
//
// THIS FILE IMPORTS NOTHING, ON PURPOSE. It is bundled into a Client Component
// (the key-model panel re-derives the leaderboard at whatever precision target
// you drag the slider to), so it cannot reach anything node-only. That rules out
// living in semanticCacheCore.ts, which imports `node:crypto` for
// fingerprintFrom — hence a module of its own rather than one more export there.
//
// It exists so the RULE has exactly one implementation. The server picks τ from
// judged events (calibrateFromJudged, semanticCacheCore) and the client picks τ
// from the curve those events produced, at a target the server never saw. Those
// two must agree exactly or the panel shows you a number that is not the one
// that would be applied — so the server builds the curve and then calls straight
// into here, and the client calls the same function on the same curve.
//
// A curve is all the information the choice needs: every candidate cut point,
// with the precision and recall its prefix achieves. The raw events add nothing
// to the decision, which is why this split is possible at all.
// ---------------------------------------------------------------------------

// One cut point. `acceptRateAtOrAbove` is the PRECISION of the set that would be
// served at this sim (accepts ÷ n), `coverageAtOrAbove` its RECALL (accepts ÷
// all accepts in the set), and `n` the size of that served set.
//
// Points are ordered by DESCENDING sim, so n grows left→right. The order is
// load-bearing: the tie-boundary test below reads its neighbour.
export type CurvePoint = {
  sim: number;
  acceptRateAtOrAbove: number;
  coverageAtOrAbove: number;
  n: number;
};

// The blocker, most-fundamental first:
//   no-events           nothing judged at all — go label something.
//   below-min-samples   judged, but never `minSamples` events in one prefix, so
//                       no prefix was ever ELIGIBLE to be recommended.
//   target-unreachable  eligible prefixes existed and none cleared `target`.
//                       This is the interesting one: `bestRate` is how close the
//                       best of them got, and `requiredN` is how large a prefix
//                       that target would have needed given its reject count.
//   null                a τ was recommended; nothing to explain.
export type AttainabilityBlocker =
  | "no-events"
  | "below-min-samples"
  | "target-unreachable"
  | null;

export type Attainability = {
  blocker: AttainabilityBlocker;
  // Best acceptance rate over ELIGIBLE prefixes (n ≥ minSamples, at a tie
  // boundary) and where it occurred. null when no prefix was eligible.
  //
  // INDEPENDENT OF `target` — it's the best any prefix does, not the best that
  // clears a bar. That's what lets the panel show a "best attainable" operating
  // point for a model that missed the target, and lets it keep showing the same
  // one as the target slider moves.
  bestRate: number | null;
  bestRateAt: { sim: number; n: number } | null;
  // Recall at that same best prefix. Carried here so a caller showing the best
  // attainable operating point never has to go back into the curve to find it —
  // a `curve.find(c => c.sim === …)` lookup returns the FIRST point with that
  // sim, which is the wrong end of a tie group.
  coverageAtBest: number | null;
  // Rejects inside that best prefix — the reason the target wasn't met.
  rejectsInBest: number;
  // The prefix size at which `target` becomes arithmetically POSSIBLE while
  // still carrying `rejectsInBest` rejects: rate ≥ target ⟺ n ≥ r / (1 − target).
  // This is the "you need n ≥ 100, you have 34" number. null when it can't be
  // stated: no eligible prefix, target ≥ 1 (no reject count is ever forgivable),
  // or the best prefix is already clean (r = 0, so the target was met).
  requiredN: number | null;
};

export type CurveSelection = {
  // The lowest — most inclusive — sim whose prefix still clears `target`.
  recommended: number | null;
  // What that prefix actually achieves. Both null when there's no τ.
  precisionAtRecommended: number | null;
  coverageAtRecommended: number | null;
  attainability: Attainability;
};

// Accepts inside a prefix, recovered from its precision. The curve stores rates
// rather than counts, and rate = accepts / n exactly, so this inverts without
// loss at any n a pair set will ever reach.
const acceptsIn = (p: CurvePoint): number => Math.round(p.acceptRateAtOrAbove * p.n);

// Pick τ: walk the curve from the strictest cut point downward and take the LAST
// one that still clears `target` — the most inclusive threshold whose served set
// keeps the false-hit rate under (1 − target).
//
// Non-monotonic dips are handled naturally: the guarantee is on the AGGREGATE
// over the served set, so a dip that later recovers is allowed. That's why this
// walks the whole curve instead of stopping at the first failure.
//
// A point is only considered at the END of a run of equal sims. Mid-run, the
// prefix covers only PART of the tie group, but serving `sim >= τ` would admit
// the whole group — so a rate measured there doesn't describe what we'd serve.
// Real cosines rarely tie exactly, so this is a correctness guarantee rather
// than a behaviour change on live data.
export function selectFromCurve(
  curve: CurvePoint[],
  target: number,
  minSamples: number,
): CurveSelection {
  let recommended: number | null = null;
  let precisionAtRecommended: number | null = null;
  let coverage: number | null = null;
  // Best ELIGIBLE prefix seen, for the attainability report. Eligibility is the
  // same predicate `recommended` uses (tie boundary + n ≥ minSamples), so the
  // explanation can never describe a prefix the selection would not consider.
  let bestRate: number | null = null;
  let bestRateAt: { sim: number; n: number } | null = null;
  let coverageAtBest: number | null = null;
  let rejectsInBest = 0;

  for (let i = 0; i < curve.length; i++) {
    const p = curve[i];
    const isTieBoundary = i === curve.length - 1 || curve[i + 1].sim !== p.sim;
    if (!isTieBoundary || p.n < minSamples) continue;

    if (bestRate === null || p.acceptRateAtOrAbove > bestRate) {
      bestRate = p.acceptRateAtOrAbove;
      bestRateAt = { sim: p.sim, n: p.n };
      coverageAtBest = p.coverageAtOrAbove;
      rejectsInBest = p.n - acceptsIn(p);
    }
    if (p.acceptRateAtOrAbove >= target) {
      recommended = p.sim;
      // Both move WITH `recommended`: τ walks downward to the most inclusive
      // value that still clears the target, and the numbers reported must be the
      // ones τ achieves, not a tighter prefix's.
      precisionAtRecommended = p.acceptRateAtOrAbove;
      coverage = p.coverageAtOrAbove;
    }
  }

  // Recall's denominator, read off the widest prefix (the last point covers
  // every event). Zero accepts anywhere means recall is undefined rather than 0
  // — there was nothing to recall.
  const last = curve[curve.length - 1];
  const totalAccepts = last === undefined ? 0 : acceptsIn(last);

  // requiredN inverts the acceptance test: accepts/n ≥ target with r rejects
  // means (n − r)/n ≥ target, i.e. n ≥ r / (1 − target). At target = 1 the
  // denominator is 0 — no prefix size ever forgives a single reject — so the
  // honest answer is "not statable" rather than Infinity. Only meaningful when
  // the best prefix actually FAILED, which is why it's gated on rejects > 0.
  const requiredN =
    bestRateAt !== null && rejectsInBest > 0 && target < 1
      ? Math.ceil(rejectsInBest / (1 - target))
      : null;

  const blocker: AttainabilityBlocker =
    recommended !== null
      ? null
      : curve.length === 0
        ? "no-events"
        : bestRateAt === null
          ? "below-min-samples"
          : "target-unreachable";

  return {
    recommended,
    precisionAtRecommended,
    coverageAtRecommended: recommended === null || totalAccepts === 0 ? null : coverage,
    attainability: {
      blocker,
      bestRate,
      bestRateAt,
      // Same rule as coverageAtRecommended: with nothing to recall, recall is
      // undefined rather than 0.
      coverageAtBest: totalAccepts === 0 ? null : coverageAtBest,
      rejectsInBest,
      requiredN,
    },
  };
}
