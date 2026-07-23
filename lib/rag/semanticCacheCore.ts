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

// ---------------------------------------------------------------------------
// PHASE 2 CALIBRATION — pure math (no DB), see docs/semantic-caching-plan.md.
// The orchestration that feeds these (eval-bank fetch, shadow-log fetch, and
// the threshold upsert) lives in semanticCacheCalibration.ts.
// ---------------------------------------------------------------------------

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Do two chunk-id sets share any element? Walk the smaller set.
const intersects = (a: Set<string>, b: Set<string>): boolean => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
};

export type CollisionFloorResult = {
  floor: number | null; // max cosine among DISTINCT-question pairs (the safety floor)
  sameAnswerMin: number | null; // min cosine among same-ground-truth pairs
  sameAnswerMedian: number | null;
  recommended: number | null; // suggested threshold, or null when uncalibratable
  distinctPairs: number;
  sameAnswerPairs: number;
  questionsUsed: number;
  overlap: boolean; // floor ≥ sameAnswerMin → no fully-safe band exists
};

// Collision-floor calibration from the eval bank. Two labeled questions that
// share a ground-truth chunk are a "same-answer" pair (a hit between them is
// roughly OK); different chunks → a "distinct" pair (a hit would serve a wrong
// answer). The FLOOR is the highest cosine among distinct pairs — the closest
// two genuinely-different questions ever land, so any threshold must sit above
// it. `recommended` is floor + margin, capped just under the lowest same-answer
// pair when a safe band exists (maximising paraphrase coverage without a false
// hit on the eval bank). Robust half is the floor: it comes only from distinct
// pairs, so the leaky "same chunk ≠ same answer" proxy can't corrupt it.
export function collisionFloor(
  labels: { questionId: string; sourceChunkId: string }[],
  vectors: Map<string, number[]>,
  margin: number,
): CollisionFloorResult {
  // Ground-truth chunk set per question that actually has a cached vector.
  const chunkSets = new Map<string, Set<string>>();
  for (const l of labels) {
    if (!vectors.has(l.questionId)) continue;
    let s = chunkSets.get(l.questionId);
    if (!s) {
      s = new Set();
      chunkSets.set(l.questionId, s);
    }
    s.add(l.sourceChunkId);
  }

  const ids = [...chunkSets.keys()];
  let floor: number | null = null;
  const sameAnswerSims: number[] = [];
  let distinctPairs = 0;

  for (let i = 0; i < ids.length; i++) {
    const vi = vectors.get(ids[i])!;
    const ci = chunkSets.get(ids[i])!;
    for (let j = i + 1; j < ids.length; j++) {
      const sim = cosine(vi, vectors.get(ids[j])!);
      if (intersects(ci, chunkSets.get(ids[j])!)) {
        sameAnswerSims.push(sim);
      } else {
        distinctPairs++;
        if (floor === null || sim > floor) floor = sim;
      }
    }
  }

  const sameAnswerMin = sameAnswerSims.length ? Math.min(...sameAnswerSims) : null;
  const overlap = floor !== null && sameAnswerMin !== null && floor >= sameAnswerMin;

  let recommended: number | null = null;
  if (floor !== null) {
    let r = floor + margin;
    if (sameAnswerMin !== null && !overlap) r = Math.min(r, sameAnswerMin);
    recommended = Math.min(1, Math.max(0, r));
  }

  return {
    floor,
    sameAnswerMin,
    sameAnswerMedian: median(sameAnswerSims),
    recommended,
    distinctPairs,
    sameAnswerPairs: sameAnswerSims.length,
    questionsUsed: ids.length,
    overlap,
  };
}

export type CalibrationResult = {
  recommended: number | null; // lowest τ whose served set stays ≥ target
  target: number;
  minSamples: number;
  totalJudged: number;
  overallAcceptRate: number | null;
  // Acceptance rate over every event AT OR ABOVE each sim — the calibration
  // curve. Points are ordered by descending sim (n grows left→right).
  curve: { sim: number; acceptRateAtOrAbove: number; n: number }[];
};

// Precision-at-threshold sweep over judged shadow events. Sort by sim desc; for
// each prefix (the top-n by similarity) the accept rate is P(accept | sim ≥
// this sim). `recommended` is the LOWEST sim whose prefix still clears `target`
// with at least `minSamples` events — i.e. the most inclusive threshold whose
// served set keeps the false-hit rate under (1 − target). Non-monotonic dips
// are handled naturally: the guarantee is on the aggregate over the served set,
// so a dip that later recovers is allowed.
export function calibrateFromJudged(
  events: { sim: number; verdict: "accept" | "reject" }[],
  target: number,
  minSamples: number,
): CalibrationResult {
  const sorted = [...events].sort((a, b) => b.sim - a.sim);
  const curve: CalibrationResult["curve"] = [];
  let accepts = 0;
  let recommended: number | null = null;

  for (let k = 0; k < sorted.length; k++) {
    if (sorted[k].verdict === "accept") accepts++;
    const n = k + 1;
    const rate = accepts / n;
    curve.push({ sim: sorted[k].sim, acceptRateAtOrAbove: rate, n });
    if (rate >= target && n >= minSamples) recommended = sorted[k].sim;
  }

  return {
    recommended,
    target,
    minSamples,
    totalJudged: sorted.length,
    overallAcceptRate: sorted.length ? accepts / sorted.length : null,
    curve,
  };
}
