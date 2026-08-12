// OFFLINE REPLAY — the pure arithmetic, split out of replayStore so it can be
// tested without a database (replayStore imports lib/db, which throws at import
// time when DATABASE_URL is unset). Same core/store split as
// semanticCacheCore.ts vs. semanticCache.ts.
//
// Everything here is deterministic and side-effect free: given a query vector, a
// gold vector and a pool, produce a rank; given ranks, produce the metrics the
// Models tab displays.
import { cosine } from "./semanticCacheCore";

// The pool ranked best-first by cosine to the query. Needed for nDCG, which
// grades the whole retrieved ORDER rather than just where the gold chunk landed.
export function rankTexts(
  queryVec: number[],
  pool: { text: string; vec: number[] }[],
): string[] {
  return pool
    .map((c) => ({ text: c.text, score: cosine(queryVec, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.text);
}

// LEAVE-ONE-OUT IDEAL RANKING — the correction that makes cross-model nDCG fair.
//
// The stored ideal is built by averaging the ranks that SEVERAL embedding models
// gave each chunk — which models is a per-config setting (0045), and each stored
// ranking records its own voters in details.models. Read that, never a current
// config value: an old ranking was built by whatever voted at the time.
//
// Scoring a VOTER against that ideal is circular: it helped define the target it's
// being graded on, which inflates its nDCG relative to a model that contributed
// nothing.
//
// The fix is free, because details.perModelRanks stores each contributor's rank per
// chunk: rebuild the average WITHOUT the model under test. A non-contributor keeps
// the full ideal — it was never advantaged.
//
// Returns chunk ids best-first, or null when excluding the model would leave
// nothing to average, in which case the caller should skip nDCG rather than grade
// against a single model's opinion.
export function leaveOneOutIdeal(
  perModelRanks: Record<string, Record<string, number>>,
  exclude: string,
): string[] | null {
  const ids = Object.keys(perModelRanks);
  if (ids.length === 0) return null;

  const scored: { id: string; meanRank: number }[] = [];
  for (const id of ids) {
    const ranks = perModelRanks[id] ?? {};
    const kept = Object.entries(ranks).filter(([model]) => model !== exclude);
    // A chunk no remaining model ranked can't be placed — drop it rather than
    // guess a position, exactly as the aggregate builder would have.
    if (kept.length === 0) continue;
    const mean = kept.reduce((s, [, r]) => s + r, 0) / kept.length;
    scored.push({ id, meanRank: mean });
  }
  if (scored.length === 0) return null;

  // Ascending: rank 1 is best. Ties broken by id so the order is deterministic
  // across runs — an unstable ideal would make nDCG jitter for no reason.
  scored.sort((a, b) => (a.meanRank !== b.meanRank ? a.meanRank - b.meanRank : a.id.localeCompare(b.id)));
  return scored.map((s) => s.id);
}

// Where the gold chunk lands when the pool is ranked by cosine to the query.
// 1-based. Counts how many chunks beat it rather than sorting the whole pool:
// same answer, no allocation, and it's the only thing we need from the ranking.
//
// STRICTLY greater, so an exact tie leaves the gold chunk ahead. Ties are
// essentially impossible between distinct float vectors, but if one occurs,
// crediting the gold chunk is the conservative reading of "the retriever found
// it" — and it keeps the metric deterministic rather than sort-order dependent.
export function goldRank(
  queryVec: number[],
  goldVec: number[],
  pool: { text: string; vec: number[] }[],
  goldText: string,
): number {
  const goldScore = cosine(queryVec, goldVec);
  let rank = 1;
  for (const c of pool) {
    if (c.text === goldText) continue;
    if (cosine(queryVec, c.vec) > goldScore) rank++;
  }
  return rank;
}

// Roll a set of gold ranks into the reported metrics. Pure, so the arithmetic
// that every number on the page rests on is testable without a database.
export function summarizeRanks(ranks: number[]): {
  questions: number;
  recallAt1: number | null;
  recallAt3: number | null;
  recallAt5: number | null;
  recallAt10: number | null;
  mrr: number | null;
} {
  const n = ranks.length;
  if (n === 0) {
    return {
      questions: 0,
      recallAt1: null,
      recallAt3: null,
      recallAt5: null,
      recallAt10: null,
      mrr: null,
    };
  }
  const atK = (k: number) => ranks.filter((r) => r <= k).length / n;
  return {
    questions: n,
    recallAt1: atK(1),
    recallAt3: atK(3),
    recallAt5: atK(5),
    recallAt10: atK(10),
    mrr: ranks.reduce((s, r) => s + 1 / r, 0) / n,
  };
}
