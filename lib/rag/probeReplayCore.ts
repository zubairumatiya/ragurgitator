// PROBE REPLAY — the pure half.
//
// Dependency-free on purpose, exactly like semanticCacheCore.ts and
// questionCacheCore.ts: no DB, no scope, no imports at all. Which pairs a capped
// run chooses is the decision most worth testing directly, and a test cannot import
// lib/rag/probeReplay.ts without dragging lib/db (and "server-only") in with it.

// The two labels the pair generator produces. Restated here rather than imported
// from semanticCachePairs so this file stays free of anything that touches a
// database; probeReplay.ts is where the two meet and the compiler checks they agree.
export type ProbeDifficulty = "paraphrase" | "hard-negative";

// A pair that can produce a MEANINGFUL probe. `variantText` is what gets replayed;
// `originText` is the banked question it is expected to land on — expected, not
// guaranteed, which is the caveat callers must not paper over (see probeReplay.ts).
export type ProbePair = {
  pairId: string;
  originQuestionId: string;
  originText: string;
  variantText: string;
  // Carried for REPORTING and for spreading a capped sample, never as a label. F3
  // measured the generator's hard-negative labels at 80% correct, and probe rows
  // land unjudged precisely so an unaudited label cannot reach a serving threshold.
  difficulty: ProbeDifficulty;
  // Whether F3's audit CONTRADICTED this pair's constructed label — the quarantine
  // flag listPairs derives from (verdict, label) in semanticCachePairs.ts:255.
  // Carried on the probe rather than left in SQL because the rule it feeds is a
  // property of three lists (poolPairs) and belongs where a test can state it.
  quarantined: boolean;
};

// THE OPTIONS EVERY PROBE IS MADE WITH. One frozen value rather than an object
// literal at the call site, because three of these four keys are the difference
// between a calibration pass and a destructive one, and all three fail SILENTLY:
//
//   serve: false     — the load-bearing one. A probe that serves would let the
//                      caller bank the variant it just replayed, and the next
//                      pass would self-match it at cosine 1.0 (f1-negatives.ts:25).
//                      Nothing downstream would look wrong; the numbers would
//                      just quietly become meaningless.
//   threshold: null  — the config's own τ, not one this pass invents. A probe is
//                      supposed to measure what the cache WOULD do.
//   keyModel: null   — likewise: the live key model, since eligibility was
//                      computed against it.
//   shadow           — floor 0 because a probe pass chooses its own floor and
//                      "below the floor" is meaningless for it; origin 'probe'
//                      because that is what keeps these rows out of the live
//                      recommendation (0069) and out of §4's pool (the F3
//                      dedupe rule).
//
// Living here means it is a VALUE a test can assert on, not a shape a reviewer
// has to eyeball — and scripts/guards.ts pins the call site to this constant so
// nobody can reintroduce a literal beside it. `as const` is what makes the seam
// real: probeReplay.ts passes this to semanticCacheLookup, so the compiler
// checks `origin: "probe"` against ShadowOrigin there, and this file still
// imports nothing.
export const PROBE_LOOKUP = {
  serve: false,
  threshold: null,
  keyModel: null,
  shadow: { floor: 0, origin: "probe" },
} as const;

// How many probes one run may add to the queue. A fresh account with a full pair
// bank has ~186 eligible (docs/probe-replay-plan.md, Phase 1's measurement), and 186
// unjudged rows would bury the real traffic queue — 7 rows on this account — under
// engineered near-misses. A queue nobody works through is the same as no queue.
export const PROBE_CAP = 40;

// Which pairs make the cut, in the order they will be probed.
//
// HARD NEGATIVES FIRST, because the queue's problem is one-sided: F7 counted 91
// judged traffic matches and 91 accepts, so the accept side is well covered and the
// reject side is empty. A paraphrase probe mostly re-confirms what is already known.
//
// AT MOST ONE PER ORIGIN QUESTION on the first pass, because eight variants of one
// question is eight judgements' work for one question's worth of evidence — and a
// spread sample is what makes the curve a curve rather than a spike. Once every
// origin is represented, the remainder fills the cap in the same priority order.
export function selectProbes(pairs: ProbePair[], cap = PROBE_CAP): ProbePair[] {
  const priority = [...pairs].sort((a, b) => {
    if (a.difficulty !== b.difficulty)
      return a.difficulty === "hard-negative" ? -1 : 1;
    return a.pairId < b.pairId ? -1 : a.pairId > b.pairId ? 1 : 0;
  });

  const seen = new Set<string>();
  const first: ProbePair[] = [];
  const rest: ProbePair[] = [];
  for (const p of priority) {
    if (seen.has(p.originQuestionId)) rest.push(p);
    else {
      seen.add(p.originQuestionId);
      first.push(p);
    }
  }
  return [...first, ...rest].slice(0, cap);
}

// --- the pool-collision rail (docs/demo-cache-lab-plan.md, Phase 4) ----------
//
// THE COLLISION, RESTATED. keyModelSweepCore's poolPairs drops a probe shadow row
// that duplicates a generated pair — including a QUARANTINED one — because a
// probe is the generated pair meeting itself, carrying the very label F3
// disproved. That rule is what stopped 8 audited-wrong rows re-entering the pool.
//
// The demo cache lab makes the collision live again in a way the merged module
// never had to face: the clone copies semantic_cache_pairs INTO a guest account
// (Phase 3) and Phase 4 lets that guest author probe rows in the same account. So
// both halves of the collision now exist in one workspace, and the only reason it
// cannot bite today is that the guest's leaderboard is banked and never
// recomputed — a fact about a UI, not about the data.
//
// The plan calls that "worth an assertion rather than a comment", so: a
// quarantined pair is FILTERED out of the guest's candidates, and the chosen pair
// is then ASSERTED not to be one. Two layers on purpose — the filter is the
// behaviour and the assertion is what fails loudly if a future eligibility query
// forgets it, rather than quietly stocking the queue with F3's 15 bad rows.
export class QuarantinedProbeError extends Error {
  constructor(pairId: string) {
    super(
      `pair ${pairId} was quarantined by the label audit and must never be probed: ` +
        "its shadow row would duplicate a generated pair carrying the label F3 disproved",
    );
    this.name = "QuarantinedProbeError";
  }
}

// The post-screen survivors — Phase 3b's "screen → quarantine → probe" order,
// enforced here rather than assumed upstream.
export const poolSafeProbes = (pairs: ProbePair[]): ProbePair[] =>
  pairs.filter((p) => !p.quarantined);

export function assertPoolSafe(pair: ProbePair): ProbePair {
  if (pair.quarantined) throw new QuarantinedProbeError(pair.pairId);
  return pair;
}

// ONE probe, chosen by the same rule a capped run uses — selectProbes with a cap
// of 1, not a second ordering. A guest's single probe should be the same probe
// the bulk job would have started with (hard negative first, since F7 left the
// reject side of the queue empty), and re-deriving "the best one" here is how the
// two would drift apart.
//
// Null rather than a throw: "nothing is eligible" is the ordinary outcome on an
// account whose banked questions have no pairs, and the caller has a sentence for
// it (docs/probe-replay-plan.md's fingerprint note).
export function selectOneProbe(pairs: ProbePair[]): ProbePair | null {
  const [chosen] = selectProbes(poolSafeProbes(pairs), 1);
  return chosen ? assertPoolSafe(chosen) : null;
}
