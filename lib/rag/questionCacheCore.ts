// QUESTION CACHE — the pure half.
//
// Dependency-free on purpose, exactly like semanticCacheCore.ts: no DB, no
// scope, no imports at all. The dedupe below is what stops "Add cached" from
// putting a question on a chunk that is already showing it, so it is the part
// most worth testing directly — and a test cannot import
// lib/rag/questionCache.ts without dragging lib/db (and its DATABASE_URL
// requirement) in with it.

// Compare question texts the way a reader would: case- and whitespace-blind.
// Nothing stronger (no punctuation stripping, no stemming) — two questions that
// differ only in wording are genuinely different questions, and dropping one
// would quietly cost coverage.
export const normalizeQuestion = (q: string): string =>
  q.trim().toLowerCase().replace(/\s+/g, " ");

// Which banked questions a chunk should actually receive.
//
// `banked` — everything the cache holds for this chunk's exact text, at any
// difficulty. `existing` — every question text already labeled to this chunk under
// the active config, whatever its source.
//
// Drops anything the chunk already shows, and anything repeated WITHIN `banked` (the
// same question can sit in two slots if two configs generated it independently).
// Order is preserved, so the caller lands them in bank order.
//
// Text is the identity here, not the slot: a chunk's existing questions may be
// hand-written, generated before the cache existed, or reused already, so a
// positional "skip the first N" rule would both miss real duplicates and skip
// perfectly good questions.
//
// `perChunk` caps how many the chunk takes from this press. The cap is applied
// AFTER the dedupe, never before: a chunk already showing its easy question would
// otherwise spend a cap of 1 on the row it is about to discard and land nothing,
// so the walk would stall on press 2. With the bank ordered easy → medium → hard
// (readBanked), a cap of 1 makes each press hand out the next difficulty up.
export function selectNewQuestions<T extends { question: string }>(
  banked: T[],
  existing: string[],
  opts: { perChunk?: number } = {},
): T[] {
  const seen = new Set(existing.map(normalizeQuestion));
  const out: T[] = [];
  const cap = opts.perChunk;
  for (const item of banked) {
    if (cap !== undefined && out.length >= cap) break;
    const key = normalizeQuestion(item.question);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
