// SEMANTIC CACHE — choosing τ from a calibration curve.
//
// THIS FILE IMPORTS NOTHING, ON PURPOSE. It is bundled into a Client Component (the
// key-model panel re-derives the leaderboard at whatever precision target you drag
// the slider to), so it cannot reach anything node-only. That rules out living in
// semanticCacheCore.ts, which imports `node:crypto`.
//
// It exists so the RULE has exactly one implementation. The server picks τ from
// judged events and the client picks τ from the curve those events produced, at a
// target the server never saw. Those two must agree exactly or the panel shows you
// a number that is not the one that would be applied.
//
// A curve is all the information the choice needs: every candidate cut point, with
// the precision and recall its prefix achieves. The raw events add nothing to the
// decision, which is why this split is possible at all.

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
//   one-class-sample    a prefix cleared `target`, but every judged event in the
//                       sample is the SAME class. With no rejects anywhere,
//                       precision is 1 at every cut point and the "recommended" τ
//                       is just the lowest sim anyone happened to observe — it
//                       measures the sample's floor, not a safe threshold. No τ is
//                       offered; `bestRate` still describes the observed point.
//   null                a τ was recommended; nothing to explain.
export type AttainabilityBlocker =
  | "no-events"
  | "below-min-samples"
  | "target-unreachable"
  | "one-class-sample"
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
// Non-monotonic dips are handled naturally: the guarantee is on the AGGREGATE over
// the served set, so a dip that later recovers is allowed. That's why this walks
// the whole curve instead of stopping at the first failure.
//
// A point is only considered at the END of a run of equal sims. Mid-run, the prefix
// covers only PART of the tie group, but serving `sim >= τ` would admit the whole
// group — so a rate measured there doesn't describe what we'd serve.
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
  const totalRejects = last === undefined ? 0 : last.n - totalAccepts;

  // A one-class sample can't calibrate anything. Gated on a τ having been picked
  // so this only fires where a number would actually have been handed out: an
  // all-REJECT sample at a sane target already yields no τ, and
  // "target-unreachable" says something more useful about it than this would.
  const oneClassSample =
    recommended !== null && (totalAccepts === 0 || totalRejects === 0);
  if (oneClassSample) {
    recommended = null;
    precisionAtRecommended = null;
    coverage = null;
  }

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
      : oneClassSample
        ? "one-class-sample"
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

// --- the slider's grid, and thinning a curve down to it ---------------------

// THE PRECISION SLIDER'S REACHABLE POSITIONS. The panel renders an
// `<input type="range">` with exactly these bounds, and reads it as
// `value / 100`, so a curve only ever has to answer 101 questions.
//
// It lives here rather than in the panel because the thinning below is only
// lossless if the two agree: widen the slider's range or halve its step and a
// published curve silently starts approximating positions it was never thinned
// for. The panel spreads these onto the input, so there is one definition.
export const TARGET_SLIDER = { min: 50, max: 100, step: 0.5 } as const;

// Every target the slider can produce, ascending. 101 of them at today's bounds.
export function sliderTargets(): number[] {
  const out: number[] = [];
  const steps = Math.round((TARGET_SLIDER.max - TARGET_SLIDER.min) / TARGET_SLIDER.step);
  for (let i = 0; i <= steps; i++) {
    out.push((TARGET_SLIDER.min + i * TARGET_SLIDER.step) / 100);
  }
  return out;
}

// THIN A CURVE TO THE POINTS THAT CAN EVER BE READ — losslessly, which is the
// whole design rather than a tolerance being accepted.
//
// A CalibrationResult holds one curve point per judged pair, so eleven models
// over a ~510-pair pooled set is ~5,600 points (~500 KB) — a page-load payload
// for something the demo wants to hand out on first render. But the panel never
// reads a curve directly: it calls selectFromCurve at one of 101 slider targets
// and renders what comes back. So keep, per model, only the points that function
// can actually return, and every number the slider can ever display stays exact.
//
// WHAT HAS TO SURVIVE, and why each one:
//   • the point selected at each target — the τ, precision and recall rows.
//   • the argmax of `bestRate` — the "best attainable" operating point shown for
//     a model that missed the target, and the one the attainability report is
//     built from. Kept once and it is still the argmax of the subset, because
//     selectFromCurve takes the FIRST strict maximum, so every earlier eligible
//     point is strictly below it.
//   • the LAST point of the full curve — selectFromCurve reads totalAccepts and
//     totalRejects off it, which is recall's denominator and the one-class test.
//
// WHAT MAY BE DROPPED WITHOUT CHANGING AN ANSWER: everything else. A dropped
// point can never become a selection in the thinned curve, since selection takes
// the LAST point clearing the target — so if a surviving later point cleared it,
// the full curve would have chosen that one too.
//
// Ties are safe by construction: only tie-boundary points are ever selected, so
// no two kept points share a sim and every kept point stays a tie boundary.
export function thinCurve(
  curve: CurvePoint[],
  targets: number[],
  minSamples: number,
): CurvePoint[] {
  if (curve.length === 0) return [];
  // Indices, not points: a curve can hold two points with the same sim, and a
  // by-value key would collapse them.
  const keep = new Set<number>([curve.length - 1]);
  const boundaryAt = new Map<number, number>();
  for (let i = 0; i < curve.length; i++) {
    const isTieBoundary = i === curve.length - 1 || curve[i + 1].sim !== curve[i].sim;
    if (isTieBoundary) boundaryAt.set(curve[i].sim, i);
  }

  for (const target of targets) {
    const sel = selectFromCurve(curve, target, minSamples);
    for (const sim of [sel.recommended, sel.attainability.bestRateAt?.sim ?? null]) {
      if (sim === null) continue;
      const i = boundaryAt.get(sim);
      // Both sims come back FROM a tie boundary, so the lookup cannot miss —
      // guarded rather than asserted because a miss here would silently publish
      // a curve that reads differently from the one measured.
      if (i !== undefined) keep.add(i);
    }
  }

  return [...keep].sort((a, b) => a - b).map((i) => curve[i]);
}

// --- packing a curve for storage --------------------------------------------

// A curve point as it is PUBLISHED: `[sim, n, accepts]`.
//
// Phase 1.5 of docs/demo-cache-lab-plan.md. Thinning already cut the payload
// from ~500 KB to ~50 KB, which is comfortable for a page load — but the meter
// that matters is not the page load. `published_sweep` is re-read from Postgres
// on every panel mount, over the app-server hop Supabase bills and does not
// compress, so the row's own size is the recurring cost.
//
// The two long float fields are DERIVABLE rather than storable:
//   acceptRateAtOrAbove = accepts / n
//   coverageAtOrAbove   = accepts / totalAccepts
// and calibrateFromJudged computes them with exactly those two divisions. So
// storing `accepts` — a small integer — and dividing on the way out is the SAME
// IEEE operation on the same operands, not a re-derivation that happens to land
// close. 50 KB becomes 18 KB with nothing given up.
//
// THE CHEAPER-LOOKING TRICK WAS TRIED AND REJECTED: rounding sims to 6dp is
// smaller still and does NOT reproduce every reading, and a threshold that
// displays a number other than the one that would be applied is the single
// failure this file exists to prevent. Measure before assuming this class of
// saving is free.
export type PackedCurvePoint = [sim: number, n: number, accepts: number];

// Accepts inside a prefix, recovered from its precision — see `acceptsIn`, which
// is the same inversion the selection uses. Exact at any n a pair set reaches.
export const packCurve = (curve: CurvePoint[]): PackedCurvePoint[] =>
  curve.map((p) => [p.sim, p.n, Math.round(p.acceptRateAtOrAbove * p.n)]);

// PRECONDITION, and the only one: the LAST point must be the widest prefix of
// the curve it came from, because recall's denominator is read off it. Both
// producers hold that — calibrateFromJudged emits every prefix, and thinCurve
// keeps the last point explicitly for this same reason — so the round trip is
// closed over everything that is ever published. Packing an arbitrary slice
// would silently rescale coverage.
export function unpackCurve(packed: PackedCurvePoint[]): CurvePoint[] {
  if (packed.length === 0) return [];
  const totalAccepts = packed[packed.length - 1][2];
  return packed.map(([sim, n, accepts]) => ({
    sim,
    acceptRateAtOrAbove: accepts / n,
    // The zero case is reproduced rather than divided: calibrateFromJudged
    // writes a literal 0 when nothing was accepted, and 0/0 is NaN.
    coverageAtOrAbove: totalAccepts === 0 ? 0 : accepts / totalAccepts,
    n,
  }));
}
