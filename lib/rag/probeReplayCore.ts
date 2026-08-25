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
};

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
    if (a.difficulty !== b.difficulty) return a.difficulty === "hard-negative" ? -1 : 1;
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
