// WHAT A PRECISION TARGET COSTS — the arithmetic behind the payoff readout beside
// the key-model slider. DB-free, so the panel can re-derive it at every slider
// position without a request, exactly as it re-derives τ from a banked curve.
//
// The page optimizes precision from end to end and never showed what precision
// BUYS. Every number on it is a cosine or a rate over labeled pairs; the thing a
// threshold actually decides — how many questions get served, and what that is
// worth — lived on /appraise/costs as a realized total with no τ attached to it.
//
// THE CENSUS. A lookup shadow-logs its nearest match whenever that match clears
// shadowLogFloor, INDEPENDENT of the serving threshold and of whether it was
// served (lib/rag/semanticCache.ts). So the shadow rows in a space are a census of
// every question that arrived with a near match, each stamped with the similarity
// that decides it — which is exactly the counterfactual "would this have been
// served at τ?" for any τ at or above the floor.
//
// THE DENOMINATOR IS FIXED, and that is what makes a rate out of it. A question
// either hit (served, never banked) or missed (banked as an entry), so
//
//     questions seen = banked entries + questions served at the LIVE threshold
//
// counts each distinct question exactly once and does not move when τ does —
// lowering τ moves a question from the entry column to the served column without
// changing how many were asked. Every rate below is over that one denominator.
//
// It is an UNDERSTATEMENT of the hit rate, in three known directions, and the UI
// says so rather than quietly presenting it as exact:
//   • entries are keyed per (key model, answering model, fingerprint), so one
//     question banked under two answering models counts twice;
//   • a repeated question that hits is served every time but counted once here;
//   • rows below the census floor are a 5% sample and are excluded outright, so a
//     τ under the floor cannot be read at all (`belowCensusFloor`).

// One similarity, floored to 4dp, and how many unblocked traffic rows sit exactly
// there. FLOORED rather than rounded so a bin can never cross a threshold upward:
// `sim >= tau` over floored values admits exactly the rows the serving path would.
export type SimBin = [sim: number, count: number];

export type CacheEconomics = {
  space: string;
  // What the space serves at now — the denominator's live threshold, not a
  // candidate. Whatever τ is being explored, "questions seen" is counted here.
  liveThreshold: number;
  // shadowLogFloor. Below it the census is a sample, not a count.
  censusFloor: number;
  // Banked answers in this space = questions that missed and were kept.
  entries: number;
  // Traffic rows at or above the floor, descending, guard-blocked rows excluded:
  // the guard turns a would-be hit into a miss no matter how high the cosine, so
  // counting those as served would promise savings the serving path refuses.
  bins: SimBin[];
  // …and how many it refused, so the recall the guard costs is visible rather
  // than silently missing from the bins.
  guardBlocked: number;
  // Realized dollars per served hit, from the savings ledger — never a modelled
  // price. null when nothing has been served yet, which leaves the readout with a
  // hit rate and no money, rather than a made-up number.
  savedPerHitUsd: number | null;
  hitsPriced: number; // the ledger events that average rests on
};

export type Payoff = {
  tau: number;
  served: number;
  questionsSeen: number;
  hitRate: number;
  // Over `questionsSeen`, and per thousand questions — the second is the one that
  // compares across accounts, since the first grows with however long the cache
  // has been running. Per THOUSAND rather than per hundred because a served hit
  // is worth fractions of a cent here, and a rate that rounds to $0.00 says
  // nothing. null when no hit has ever been priced.
  savedUsd: number | null;
  perThousandUsd: number | null;
  // τ sits under the census floor, so `served` counts only what was logged and is
  // a LOWER BOUND on what that τ would serve.
  belowCensusFloor: boolean;
};

// Questions the census would serve at τ. Linear over ~100 bins, called on every
// slider tick.
export function servedAt(bins: SimBin[], tau: number): number {
  let n = 0;
  for (const [sim, count] of bins) {
    if (sim >= tau) n += count;
    else break; // descending
  }
  return n;
}

export function payoffAt(econ: CacheEconomics, tau: number): Payoff | null {
  const questionsSeen = econ.entries + servedAt(econ.bins, econ.liveThreshold);
  if (questionsSeen === 0) return null;
  const served = servedAt(econ.bins, tau);
  const hitRate = served / questionsSeen;
  const per = econ.savedPerHitUsd;
  return {
    tau,
    served,
    questionsSeen,
    hitRate,
    savedUsd: per === null ? null : served * per,
    perThousandUsd: per === null ? null : hitRate * 1000 * per,
    belowCensusFloor: tau < econ.censusFloor,
  };
}

// THE CEILING, and why the slider stops well short of the published band.
//
// The sum of the bins: the most any τ AT OR ABOVE THE CENSUS FLOOR could serve.
// Worth stating on screen because the two rates beside it move in opposite ways —
// recall@τ hits 100% while the hit rate sits at a fifth — and without it that
// reads as a contradiction rather than as "most questions arrived near nothing".
//
// NOT A TRUE CEILING, and the UI must not call it one. A row is in the bins only
// because its nearest match cleared shadowLogFloor at lookup time; a question
// whose best match was 0.6 was never logged, so a τ of 0.6 would serve it and
// nothing here can count it. Below the floor this number under-states, which is
// the same blind spot `belowCensusFloor` flags on the served count. Lowering τ
// past the floor therefore buys real hits — of unmeasured precision, which is
// exactly why the floor is where it is.
export function censusCeiling(econ: CacheEconomics): { matched: number; rate: number } | null {
  const questionsSeen = econ.entries + servedAt(econ.bins, econ.liveThreshold);
  if (questionsSeen === 0) return null;
  const matched = econ.bins.reduce((n, [, count]) => n + count, 0);
  return { matched, rate: matched / questionsSeen };
}

// Published hit rates, for scale. Production semantic caches report 30–70%
// (GPTCache; GPT Semantic Cache measures 61–69% fewer calls) — see
// docs/long-term-savings-research.md §5.2. Quoted as a RANGE and never as a
// target: a workbench whose traffic is mostly novel eval questions has no
// business clearing it, and the same doc says so.
export const REFERENCE_HIT_RATE = { low: 0.3, high: 0.7 } as const;
