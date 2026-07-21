// Contract tests for the semantic-cache CORE — the decisions that make a hit
// correct: nearest-match selection, the threshold gate, per-space threshold
// keying, and fingerprint validity. Imports only semanticCacheCore (which is
// DB-free), so it runs without a DATABASE_URL, exactly like evalMetrics.test.ts.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { bestMatch, isHit, spaceOf, fingerprintFrom, cosine } from "./semanticCacheCore";

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
