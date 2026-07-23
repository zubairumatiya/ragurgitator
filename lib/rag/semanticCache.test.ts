// Contract tests for the semantic-cache CORE — the decisions that make a hit
// correct: nearest-match selection, the threshold gate, per-space threshold
// keying, and fingerprint validity. Imports only semanticCacheCore (which is
// DB-free), so it runs without a DATABASE_URL, exactly like evalMetrics.test.ts.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bestMatch,
  calibrateFromJudged,
  collisionFloor,
  cosine,
  fingerprintFrom,
  isHit,
  spaceOf,
} from "./semanticCacheCore";

test("cosine: identical vectors are 1, orthogonal are 0, zero-vector is 0", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  // Magnitude doesn't matter — direction does.
  assert.ok(Math.abs(cosine([2, 0], [5, 0]) - 1) < 1e-12);
});

test("bestMatch: returns null when there are no candidates", () => {
  assert.equal(bestMatch([1, 0], []), null);
});

test("bestMatch: picks the highest-cosine entry and reports its sim", () => {
  const q = [1, 0];
  const entries = [
    { vector: [0, 1], value: "orthogonal" },
    { vector: [0.9, 0.1], value: "close" },
    { vector: [0.6, 0.8], value: "middling" },
  ];
  const best = bestMatch(q, entries);
  assert.ok(best !== null);
  assert.equal(best.value, "close");
  assert.ok(best.sim > 0.9 && best.sim < 1);
});

test("bestMatch: an exact-repeat query matches at sim ≈ 1", () => {
  const q = [0.3, 0.4, 0.5];
  const best = bestMatch(q, [{ vector: [0.3, 0.4, 0.5], value: "same" }]);
  assert.ok(best !== null);
  assert.ok(Math.abs(best.sim - 1) < 1e-12);
});

test("isHit: gate is inclusive at the threshold", () => {
  assert.equal(isHit(0.95, 0.95), true); // boundary hits
  assert.equal(isHit(0.9499, 0.95), false);
  assert.equal(isHit(0.99, 0.95), true);
});

test("spaceOf: same-space models collapse to one threshold key; others are self", () => {
  // voyage-4 family shares vectorSpace "voyage-4" (see embeddingModels.ts).
  assert.equal(spaceOf("voyage-4-lite"), "voyage-4");
  assert.equal(spaceOf("voyage-4-large"), "voyage-4");
  assert.equal(spaceOf("voyage-4-lite"), spaceOf("voyage-4"));
  // A model without a vectorSpace tag is its own space.
  assert.equal(spaceOf("voyage-code-3"), "voyage-code-3");
  // Different providers are never the same space.
  assert.notEqual(spaceOf("voyage-4-lite"), spaceOf("text-embedding-3-large"));
  // An unknown model id falls back to itself (never throws).
  assert.equal(spaceOf("made-up-model"), "made-up-model");
});

test("fingerprintFrom: deterministic for identical inputs", () => {
  const a = fingerprintFrom(["sc-v1", "voyage-4-lite", 512, 50, 5, null, "claude", "baseline", "c:10"]);
  const b = fingerprintFrom(["sc-v1", "voyage-4-lite", 512, 50, 5, null, "claude", "baseline", "c:10"]);
  assert.equal(a, b);
});

test("fingerprintFrom: any changed part flips the fingerprint", () => {
  const base = fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude", "baseline", "c:10"]);
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 256, 50, 5, "claude", "baseline", "c:10"])); // chunk size
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude-2", "baseline", "c:10"])); // llm
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude", "override-x", "c:10"])); // overrides
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude", "baseline", "c:11"])); // corpus
});

test("fingerprintFrom: null is distinct from the strings that could collide with it", () => {
  const withNull = fingerprintFrom(["a", null, "b"]);
  assert.notEqual(withNull, fingerprintFrom(["a", "null", "b"]));
  assert.notEqual(withNull, fingerprintFrom(["a", "", "b"]));
  assert.notEqual(withNull, fingerprintFrom(["a", "∅", "b"]));
});

test("fingerprintFrom: field boundaries can't be forged by concatenation", () => {
  // Without a delimiter, ["ab","c"] and ["a","bc"] would collide; the separator
  // keeps a value's content from bleeding into the next field.
  assert.notEqual(fingerprintFrom(["ab", "c"]), fingerprintFrom(["a", "bc"]));
});

// --- Phase 2 calibration: collision floor -----------------------------------

test("collisionFloor: floor is the max cosine among DISTINCT-chunk pairs", () => {
  // q1,q2 → chunk A (same-answer, near-identical); q3 → chunk B, far from both.
  const vectors = new Map<string, number[]>([
    ["q1", [1, 0]],
    ["q2", [0.99, 0.14]], // very close to q1 (cos ≈ 0.99)
    ["q3", [0, 1]], // distinct question, far from q1/q2 (cos ≈ 0 / 0.14)
  ]);
  const labels = [
    { questionId: "q1", sourceChunkId: "A" },
    { questionId: "q2", sourceChunkId: "A" },
    { questionId: "q3", sourceChunkId: "B" },
  ];
  const r = collisionFloor(labels, vectors, 0.01);
  assert.equal(r.distinctPairs, 2); // q1-q3, q2-q3
  assert.equal(r.sameAnswerPairs, 1); // q1-q2
  // A safe band exists: the floor (closest distinct pair) sits well below the
  // same-answer pair, so recommended lands just above the floor and would catch
  // q1↔q2 but never q*↔q3.
  assert.ok(r.floor !== null && r.floor! < 0.5);
  assert.ok(r.sameAnswerMin !== null && r.sameAnswerMin! > 0.95);
  assert.equal(r.overlap, false);
  assert.ok(r.recommended !== null && r.recommended > r.floor!);
  assert.ok(r.recommended! <= r.sameAnswerMin!);
});

test("collisionFloor: reports overlap when a distinct pair is closer than a same-answer pair", () => {
  const vectors = new Map<string, number[]>([
    ["q1", [1, 0]],
    ["q2", [0.6, 0.8]], // same chunk as q1 but far apart
    ["q3", [0.99, 0.14]], // different chunk yet very close to q1
  ]);
  const labels = [
    { questionId: "q1", sourceChunkId: "A" },
    { questionId: "q2", sourceChunkId: "A" },
    { questionId: "q3", sourceChunkId: "B" },
  ];
  const r = collisionFloor(labels, vectors, 0.01);
  assert.equal(r.overlap, true); // floor ≥ sameAnswerMin → no fully-safe band
  assert.ok(r.recommended !== null && r.recommended > r.floor!); // stays above the floor
});

test("collisionFloor: questions without a cached vector are skipped", () => {
  const vectors = new Map<string, number[]>([["q1", [1, 0]]]);
  const labels = [
    { questionId: "q1", sourceChunkId: "A" },
    { questionId: "q2", sourceChunkId: "B" }, // no vector → dropped
  ];
  const r = collisionFloor(labels, vectors, 0.01);
  assert.equal(r.questionsUsed, 1);
  assert.equal(r.distinctPairs, 0);
  assert.equal(r.floor, null);
  assert.equal(r.recommended, null); // nothing to calibrate against
});

// --- Phase 2 calibration: precision-at-threshold sweep ----------------------

test("calibrateFromJudged: recommends the lowest τ whose served set stays ≥ target", () => {
  // High sims accept, low sims reject. With target 1.0 and minSamples 1, the
  // lowest all-accept prefix boundary is 0.90.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.85, verdict: "reject" as const },
    { sim: 0.82, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 1.0, 1);
  assert.equal(r.recommended, 0.9);
  assert.equal(r.totalJudged, 5);
  assert.ok(Math.abs(r.overallAcceptRate! - 3 / 5) < 1e-9);
});

test("calibrateFromJudged: tolerates a dip that recovers (aggregate guarantee)", () => {
  // One reject at 0.90 drops the prefix rate to 0.75, but two accepts below pull
  // the aggregate over [0.80,1] back to 4/5 = 0.80 ≥ target.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
    { sim: 0.85, verdict: "accept" as const },
    { sim: 0.8, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 0.8, 1);
  assert.equal(r.recommended, 0.8); // most inclusive prefix still ≥ 0.8
});

test("calibrateFromJudged: no recommendation below the minimum sample size", () => {
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 0.9, 20);
  assert.equal(r.recommended, null);
});
