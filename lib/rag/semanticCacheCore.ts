// ---------------------------------------------------------------------------
// SEMANTIC CACHE — pure core (no DB, no I/O), so it's unit-testable without a
// database connection (mirrors how evalMetrics.ts is split out of eval.ts —
// the test imports THIS file, not the DB-touching orchestration).
//
// The cache serves a PAST answer for a NEW question when the two are close
// enough in embedding space — see docs/semantic-caching-plan.md. This file owns
// the three decisions that make a hit correct:
//   - spaceOf()             which threshold applies (per embedding vector-space)
//   - bestMatch() / isHit() is the nearest cached query close enough to serve?
//   - fingerprintFrom()     is a cached entry still valid for today's config?
// Everything here is deterministic and dependency-light on purpose.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

// RELATIVE import on purpose: EMBEDDING_MODELS is a VALUE import, and the test
// runner (node --import tsx) doesn't resolve the "@/" path alias for runtime
// values — only Next's bundler does. embeddingModels.ts is itself dependency-
// free, so this stays importable without a DATABASE_URL.
import { EMBEDDING_MODELS } from "./embeddingModels";

// Cosine similarity between two same-dimension vectors. Duplicated from
// embedCache.cosine ON PURPOSE: that module imports the DB client at load, so
// importing its cosine would drag the DB into this test-safe core. The math is
// identical — normalize defensively (query and cached vectors are the same
// model, so dims match), 0 on a zero vector.
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export type CacheEntry<T> = { vector: number[]; value: T };

// The nearest cached entry to `queryVec` and its cosine, or null when there are
// no candidates. "Nearest" is by cosine (the whole app compares embeddings this
// way); a tie keeps the first seen. The caller decides whether `sim` clears the
// threshold — this only finds the best match, it doesn't judge it.
export function bestMatch<T>(
  queryVec: number[],
  entries: CacheEntry<T>[],
): { value: T; sim: number } | null {
  let best: { value: T; sim: number } | null = null;
  for (const e of entries) {
    const sim = cosine(queryVec, e.vector);
    if (best === null || sim > best.sim) best = { value: e.value, sim };
  }
  return best;
}

// A hit needs sim AT OR ABOVE threshold. An exact-repeat question lands at
// sim ≈ 1, so it hits under any threshold; the threshold only governs how much
// PARAPHRASE we're willing to treat as the same question.
export function isHit(sim: number, threshold: number): boolean {
  return sim >= threshold;
}

// Which threshold governs a model's hits. Models that emit into the SAME
// cosine-comparable space share one threshold (their similarity scores are on
// the same scale); a model with no vectorSpace tag is its own space. This is
// also why entries are scoped by embedding_model in the DB — a query embedded
// under model A must never be matched against entries from a different space.
export function spaceOf(model: string): string {
  return EMBEDDING_MODELS[model]?.vectorSpace ?? model;
}

// Deterministic fingerprint of everything that determines a cached answer. Two
// entries with the same fingerprint were produced by the same config shape
// (embedding model, chunking, top-k, fusion pool, LLM) over the same corpus and
// override state, so serving one for the other is safe. Any change flips the
// fingerprint; stale entries then stop matching (and get GC'd on the next
// store). Null-safe: a null part (e.g. auto fusion pool) is encoded distinctly
// from the string "null" or "" so "auto" and an actual value can't collide.
export function fingerprintFrom(parts: (string | number | null)[]): string {
  // "∅" marks null; every present value is prefixed with "·" so it can NEVER
  // equal the null marker — even a part whose literal value is "∅". "␟"
  // separates fields so one value's content can't bleed into the next.
  const canonical = parts
    .map((p) => (p === null ? "∅" : `·${p}`))
    .join("␟");
  return createHash("sha256").update(canonical).digest("hex");
}
