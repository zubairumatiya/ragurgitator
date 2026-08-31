// Where the SQL half and the JS half of a fusion dry-run meet.
//
// docs/fusion-egress-plan.md §1.1 / DECISION 3: the retriever now asks Postgres
// for the best override sim per chunk (overrideStore.overrideSims) instead of
// downloading every piece vector. A model TRIAL cannot do that for the candidate
// it is trying — those vectors are the thing being considered and exist only in
// memory, never in config_chunk_overrides — so a trial keeps cosine-ing them in
// JS and folds the result into the SQL map here.
//
// The fold has to reproduce exactly what the single JS loop used to do: take the
// MAX over all of a chunk's pieces, stored and candidate alike. It is pure and
// tiny on purpose — this is the seam the equivalence script cannot cover, because
// the candidate side has no SQL counterpart to compare against.
export function withCandidateSims(
  stored: Map<string, number>,
  chunkId: string,
  candidateSims: number[],
): Map<string, number> {
  // Copied, never mutated in place: `stored` may be a cached map shared with
  // another rung, and a trial must not leave its candidate behind in it.
  const merged = new Map(stored);
  for (const sim of candidateSims) {
    const prev = merged.get(chunkId);
    if (prev === undefined || sim > prev) merged.set(chunkId, sim);
  }
  return merged;
}
