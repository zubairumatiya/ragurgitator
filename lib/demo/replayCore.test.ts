// replayCore — phase 1 of docs/demo-cache-replay-plan.md.
//
// The store banks a similarity matrix and the demo subsets it by "the first n".
// Three properties carry that, and none of them is visible on a page that looks
// right:
//
//   1. IDENTITY IS UNORDERED AND TEXT-DERIVED. "The first n" has to mean the same
//      n pairs on both sides of the clone and across both publish hops, and a
//      pair is unordered everywhere else in the sweep — so an identity that told
//      (a, b) from (b, a) would call one pair two the first time a shadow row
//      arrived the other way round.
//   2. THE RECTANGLE IS CHECKED AT PUBLISH TIME. A sims row shorter than `pairs`
//      is a leaderboard quietly scoring a different pair set per model, which is
//      the single hardest defect to see on the finished page. It must throw
//      where it is written, not where it is read.
//   3. ROUNDING IS LOSSLESS TO EVERY READER. The sims are rounded to shrink the
//      payload; the assertion is that what comes back is within a hair of what
//      went in, so no caller can be reading a number the master did not compute.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_MATRIX_MAX_BYTES,
  matrixBytes,
  packMatrix,
  pairIdentity,
  roundSim,
  simsFor,
  type ReplayPair,
} from "@/lib/demo/replayCore";

const pair = (hash: string, over: Partial<ReplayPair> = {}): ReplayPair => ({
  hash,
  label: "same",
  source: "generated",
  difficulty: "paraphrase",
  quarantined: false,
  ...over,
});

test("pair identity is unordered", () => {
  assert.equal(pairIdentity("alpha", "beta"), pairIdentity("beta", "alpha"));
});

test("pair identity separates different texts", () => {
  assert.notEqual(pairIdentity("alpha", "beta"), pairIdentity("alpha", "betaa"));
  // The NUL separator is what stops "ab"+"c" forging "a"+"bc"; assert it rather
  // than trusting the separator's invisibility.
  assert.notEqual(pairIdentity("ab", "c"), pairIdentity("a", "bc"));
});

test("packMatrix rejects a model that scored the wrong number of pairs", () => {
  assert.throws(
    () =>
      packMatrix({
        models: ["m1"],
        pairs: [pair("h1"), pair("h2")],
        sims: [[0.5]],
        target: 0.95,
        minSamples: 20,
      }),
    /scored 1 of 2/,
  );
});

test("packMatrix rejects a sims row per model mismatch", () => {
  assert.throws(
    () => packMatrix({ models: ["m1", "m2"], pairs: [pair("h1")], sims: [[0.5]], target: 0.95, minSamples: 20 }),
    /1 sim rows for 2 models/,
  );
});

test("packMatrix keeps an unscored model as null, not as a row of zeros", () => {
  const m = packMatrix({
    models: ["m1", "m2"],
    pairs: [pair("h1")],
    sims: [[0.5], null],
    target: 0.95,
    minSamples: 20,
  });
  assert.equal(simsFor(m, "m2"), null);
  assert.deepEqual(simsFor(m, "m1"), [0.5]);
  assert.equal(simsFor(m, "nobody"), null);
});

test("rounding stays within a hair of the sim that was measured", () => {
  for (const sim of [0.0, 0.123456789, 0.9999994, 0.87654321, 1.0, -0.4444449]) {
    assert.ok(Math.abs(roundSim(sim) - sim) < 1e-6, `${sim} moved too far`);
  }
});

test("a full-size matrix fits well under the soft ceiling", () => {
  // The publish's real shape: ~345 pooled pairs under 11 candidate models. The
  // ceiling is soft and scripts/demo-snapshot only reports against it, so this
  // asserts the SIZING ARGUMENT rather than the limit — if a matrix of the
  // master's dimensions ever approached 150 kB, the rounding above stopped
  // working and every guest pays for it on page load.
  const pairs = Array.from({ length: 345 }, (_, i) => pair(`h${i}`));
  const sims = Array.from({ length: 11 }, () => pairs.map((_, i) => 0.5 + (i % 1000) / 3000));
  const bytes = matrixBytes(packMatrix({ models: Array.from({ length: 11 }, (_, i) => `m${i}`), pairs, sims, target: 0.95, minSamples: 20 }));
  assert.ok(bytes < DEMO_MATRIX_MAX_BYTES, `matrix is ${bytes} bytes`);
});
