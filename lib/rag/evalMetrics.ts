// Pure ranking-metric math, shared by the server (summary aggregates, run
// snapshots) and the client (per-question chips on /eval).
//
// reciprocalRank stays single-relevant (MRR): the ground-truth chunk's 1-based
// rank in the retrieved list, 0 on a miss.
//
// nDCG is GRADED. It needs an *ideal* ranking of several chunks, built per
// question on /eval (lib/rag/ranking.ts). A chunk's relevance gain is derived
// from its position in that ideal order — the top chunk scores highest,
// decreasing by one per position, and any chunk not in the ideal set scores 0.
// nDCG@k = DCG@k / IDCG@k over the retrieved order. With no ideal ranking there
// is nothing to grade against (IDCG = 0), so it returns null (ungraded) rather
// than a misleading 0 or 1 — which is what lets the UI show it as not-yet-graded.

export function reciprocalRank(rank: number | null): number {
  return rank ? 1 / rank : 0;
}

// Relevance gain per chunk, by its position in the ideal ranking: the first
// chunk scores idealOrder.length, the last scores 1, anything absent scores 0.
function gainByIdealRank(idealOrder: string[]): Map<string, number> {
  const n = idealOrder.length;
  return new Map(idealOrder.map((id, i) => [id, n - i]));
}

// Discounted cumulative gain over the first k of `order`, using `gain`.
function dcg(order: string[], gain: Map<string, number>, k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, order.length); i++) {
    sum += (gain.get(order[i]) ?? 0) / Math.log2(i + 2);
  }
  return sum;
}

// Graded nDCG@k: how well `retrievedOrder` matches `idealOrder`. idealOrder is
// already best-first, so its own DCG is the ideal (IDCG). Returns null when
// there's no ideal ranking to grade against.
export function ndcg(
  idealOrder: string[],
  retrievedOrder: string[],
  k: number,
): number | null {
  const gain = gainByIdealRank(idealOrder);
  const idcg = dcg(idealOrder, gain, k);
  if (idcg === 0) return null;
  return dcg(retrievedOrder, gain, k) / idcg;
}
