// Pure per-question metric math, shared by the server (summary aggregates, run
// snapshots) and the client (per-question chips on /eval). Every metric derives
// from the ground-truth chunk's 1-based rank in the retrieved list (found_rank):
// with exactly ONE relevant chunk per question, the ideal ranking puts it at
// rank 1, so IDCG = 1 and nDCG collapses to the discount at its actual rank.
// A miss (rank null) scores 0 for both.

export function reciprocalRank(rank: number | null): number {
  return rank ? 1 / rank : 0;
}

export function ndcgAtRank(rank: number | null): number {
  return rank ? 1 / Math.log2(rank + 1) : 0;
}
