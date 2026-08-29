// COMPOSING THE DEMO'S SPARE QUESTIONS — the pure half of lib/demo/publishedBank.
//
// Dependency-free for the reason every *Core.ts here is: the rule this file
// encodes is the whole feature, and a test for it must not need a database, a
// scope, or a published build to run.
//
// WHAT THE RULE IS. Twelve questions "Add cached" will hand a guest, chosen from
// the frozen set so that they look like the tunable twelve rather than like a
// slice of whatever was left. Two properties, in this order:
//
//   COMPOSITION — the same QUOTAS lib/demo/tunable.ts weights the tunable twelve
//     by (4 missed, 3 rank 4, 3 rank 3, 1 rank 2, 1 rank 1). Autotune only has
//     work to do on questions that are FAILING, so a bank of comfortable
//     questions is a button that does nothing; but a bank of nothing BUT misses
//     is a caricature of the corpus. The first cut of this took worst-first and
//     produced 10 misses out of 12, which is how that lesson was learnt.
//   SPREAD — a document counter shared across every quota, so twelve questions
//     come from as many files as the corpus has. The bank this replaced was
//     twelve questions about one file.
//
// The top-up exists because a quota can come up short (a corpus with two rank-2
// questions left cannot supply three), and twelve questions with a slightly wrong
// mix beats nine with the right one.
export type BankCandidate = {
  questionId: string;
  documentId: string;
  // found_rank of the question's last baseline score; 99 = not found at all.
  tier: number;
};

// Take `n` items, preferring at every step the document with the fewest picks so
// far and breaking ties by the caller's order.
//
// A COUNTER SHARED ACROSS THE WHOLE SELECTION, not a round-robin inside each
// tier, and the difference is the entire spread property. Per-tier interleaving
// restarts at the first document every time, so five quotas over six documents
// deal 0,1,2,3 → 0,1,2 → 0,1,2 → 0 → 0 and reach four documents while looking
// like it spread. Counting globally deals every document its share of the twelve.
//
// The input order is already stable and uncorrelated with ingest order (md5 of
// the id, matching tunable.ts), so this adds spread without adding a second
// notion of which question is preferable.
function takeSpread<T extends BankCandidate>(
  pool: T[],
  n: number,
  used: Map<string, number>,
): T[] {
  const remaining = [...pool];
  const out: T[] = [];
  while (out.length < n && remaining.length > 0) {
    let bestIndex = 0;
    let bestCount = Infinity;
    for (const [i, candidate] of remaining.entries()) {
      const count = used.get(candidate.documentId) ?? 0;
      if (count < bestCount) {
        bestIndex = i;
        bestCount = count;
      }
      if (bestCount === 0) break; // nothing beats an untouched document
    }
    const [picked] = remaining.splice(bestIndex, 1);
    used.set(picked.documentId, bestCount + 1);
    out.push(picked);
  }
  return out;
}

// `candidates` — one question per eligible chunk, in the order the query chose
// (worst tier first, stable tie-break). `quotas` — tunable.ts's QUOTAS.
export function composeBank<T extends BankCandidate>(
  candidates: T[],
  quotas: { tier: number; n: number }[],
  cap: number,
): T[] {
  const used = new Map<string, number>();
  const picked: T[] = [];
  const taken = new Set<string>();

  for (const quota of quotas) {
    const room = Math.min(quota.n, cap - picked.length);
    if (room <= 0) break;
    const pool = candidates.filter((c) => c.tier === quota.tier);
    for (const c of takeSpread(pool, room, used)) {
      picked.push(c);
      taken.add(c.questionId);
    }
  }

  // TOP UP, worst-first, when a quota could not be filled — a corpus with two
  // rank-2 questions left cannot supply three, and twelve questions with a
  // slightly wrong mix beat nine with the right one. Same counter, so the extras
  // keep landing in the least-represented documents.
  if (picked.length < cap) {
    const rest = candidates
      .filter((c) => !taken.has(c.questionId))
      .sort((a, b) => b.tier - a.tier);
    for (const c of takeSpread(rest, cap - picked.length, used)) {
      picked.push(c);
      taken.add(c.questionId);
    }
  }

  return picked;
}
