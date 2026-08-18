// PRECISION UNDER THE NATURAL PRIOR (F7).
//
// calibrateFromJudged reads precision straight off the sample: of the events at or
// above τ, what share were accepts. That is the right thing to do when the sample
// IS the population — and wrong when it isn't. F1's probe set is half engineered
// near-misses, a mix real traffic has never produced, so its "88.3% precision at
// τ=0.95" is a bound against an adversarial question mix rather than an estimate
// of what this account would see.
//
// The fix is not to throw the probes away — they are the only place enough
// negatives exist to measure a false-positive rate at all. It is to stop letting
// them set the PREVALENCE. So:
//
//   • the CLASS-CONDITIONAL SHAPES — P(sim ≥ τ | accept) and P(sim ≥ τ | reject) —
//     come from the pooled sample, probes included, where both classes are dense;
//   • the PRIOR — P(accept) among matches real traffic actually produces — comes
//     from traffic rows alone;
//   • Bayes recombines them.
//
//     precision(τ) = π·TPR(τ) / ( π·TPR(τ) + (1−π)·FPR(τ) )
//
// WHAT THIS DOES NOT FIX, and it must be said wherever the number is quoted: the
// probe negatives are HARDER than natural ones by construction — they were written
// to sit next to a banked question. Reweighting corrects how OFTEN a negative
// arrives, not how close it sits when it does. FPR is therefore still
// pessimistic, so the estimate stays conservative — it is an estimate under a
// realistic prior and an adversarial negative shape, which is a strictly tighter
// claim than the raw bound but not an unbiased one.
//
// The population being conditioned on throughout is "a lookup that found a
// candidate match in the logged band" — not "a question". Precision is a property
// of what gets SERVED, so the questions that never matched anything are correctly
// outside it.

export type PriorPoint = {
  sim: number; // τ, a candidate operating point
  tpr: number; // P(sim ≥ τ | accept) — also the recall a τ achieves
  fpr: number; // P(sim ≥ τ | reject) — the false-hit rate among negatives
  // Precision under the supplied prior. null only when NOTHING is served at this
  // τ under either class, where a rate has no denominator.
  precision: number | null;
  // P(sim ≥ τ) under the prior — the share of candidate matches that would be
  // served. The savings side of the trade, in the reweighted world.
  servedRate: number;
  // Raw counts behind the point, so a precision resting on two events can be
  // told apart from one resting on two hundred.
  accepts: number;
  rejects: number;
};

export type PriorCurve = {
  prior: number;
  points: PriorPoint[]; // descending sim, like calibrateFromJudged's curve
  totalAccepts: number;
  totalRejects: number;
};

// Both classes are required. With one class there is no reweighting to do — the
// answer would be 0 or 1 for every τ, which is an artifact of the sample and not
// a measurement. Same refusal `selectFromCurve` makes for a one-class sample.
export function priorCurve(
  events: { sim: number; verdict: "accept" | "reject" }[],
  prior: number,
): PriorCurve | null {
  const totalAccepts = events.filter((e) => e.verdict === "accept").length;
  const totalRejects = events.length - totalAccepts;
  if (totalAccepts === 0 || totalRejects === 0) return null;
  if (!(prior > 0 && prior < 1)) return null;

  const sorted = [...events].sort((a, b) => b.sim - a.sim);
  const points: PriorPoint[] = [];
  let accepts = 0;
  let rejects = 0;
  for (let k = 0; k < sorted.length; k++) {
    if (sorted[k].verdict === "accept") accepts++;
    else rejects++;
    // Emit ONE point per distinct sim, at the tie boundary. `sim >= τ` admits
    // the whole tie group, so a point in the middle of one would describe a
    // served set that no threshold can actually produce.
    if (k + 1 < sorted.length && sorted[k + 1].sim === sorted[k].sim) continue;

    const tpr = accepts / totalAccepts;
    const fpr = rejects / totalRejects;
    const served = prior * tpr + (1 - prior) * fpr;
    points.push({
      sim: sorted[k].sim,
      tpr,
      fpr,
      precision: served === 0 ? null : (prior * tpr) / served,
      servedRate: served,
      accepts,
      rejects,
    });
  }
  return { prior, points, totalAccepts, totalRejects };
}

// Precision at one specific τ — the read F7 is actually after ("what is τ=0.95
// worth under the natural prior"). Uses the LAST point at or above τ, i.e. the
// whole served set `sim >= τ`, which is what serving does. null when nothing in
// the sample reaches τ.
export function precisionAt(curve: PriorCurve, tau: number): PriorPoint | null {
  let last: PriorPoint | null = null;
  for (const p of curve.points) {
    if (p.sim < tau) break;
    last = p;
  }
  return last;
}

// The lowest τ whose reweighted precision still clears `target`, with at least
// `minSamples` raw events behind it. Mirrors selectFromCurve's rule — most
// inclusive threshold that holds the guarantee — but on the reweighted rate.
export function recommendUnderPrior(
  curve: PriorCurve,
  target: number,
  minSamples: number,
): PriorPoint | null {
  let best: PriorPoint | null = null;
  for (const p of curve.points) {
    if (p.accepts + p.rejects < minSamples) continue;
    if (p.precision !== null && p.precision >= target) best = p;
  }
  return best;
}

// Wilson score interval — the prior is a proportion off ~90 events, and a normal
// approximation on a proportion that near 1 produces bounds above 1. Two-sided,
// z=1.96 (95%).
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}
