// ---------------------------------------------------------------------------
// OFFLINE REPLAY — the pure arithmetic, split out of replayStore so it can be
// tested without a database (replayStore imports lib/db, which throws at import
// time when DATABASE_URL is unset). Same core/store split as
// semanticCacheCore.ts vs. semanticCache.ts.
//
// Everything here is deterministic and side-effect free: given a query vector, a
// gold vector and a pool, produce a rank; given ranks, produce the metrics the
// Models tab displays.
// ---------------------------------------------------------------------------
import { cosine } from "./semanticCacheCore";

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
