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
  bankedRetrieval,
  chooseTuningKey,
  DEMO_MATRIX_MAX_BYTES,
  matrixBytes,
  packMatrix,
  packRetrieval,
  pairIdentity,
  type ReplayRetrieval,
  type RetrievalRecord,
  roundSim,
  simsFor,
  textHash,
  TUNING_KEY,
  tuningKey,
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

// --- the tuning bank keys (docs/demo-voyage-tuning-plan.md §3.2, §3.4) --------

test("tuningKey is a function of the SET: order and repeats do not change it", () => {
  assert.equal(tuningKey(["medium", "easy", "easy"]), "set:easy+medium");
  assert.equal(tuningKey(["easy"]), "set:easy");
  assert.equal(tuningKey([]), "set:");
});

test("chooseTuningKey: exact set first, then the smallest superset, then the legacy key", () => {
  const banks = ["set:easy", "set:medium", "set:easy+medium", TUNING_KEY];
  assert.equal(chooseTuningKey(["easy"], banks), "set:easy");
  assert.equal(chooseTuningKey(["medium", "easy"], banks), "set:easy+medium");
  // A one-difficulty board on a build that banked only the full set.
  assert.equal(chooseTuningKey(["easy"], ["set:easy+medium", TUNING_KEY]), "set:easy+medium");
  // A difficulty no set covers falls through to the pre-plan bank …
  assert.equal(chooseTuningKey(["hard"], banks), TUNING_KEY);
  // … and to nothing when there is none: the step then refuses, as for an
  // empty shelf.
  assert.equal(chooseTuningKey(["hard"], ["set:easy"]), null);
  assert.equal(chooseTuningKey(["easy"], []), null);
});

test("chooseTuningKey never widens past the smallest set that covers the board", () => {
  assert.equal(
    chooseTuningKey(["easy"], ["set:easy+hard+medium", "set:easy+medium"]),
    "set:easy+medium",
  );
});

// --- the retrieval bank (docs/demo-retrieval-bank-plan.md) --------------------
//
// The lookup is where every fail-closed rule lives, and each rule is a way a
// guest could otherwise be served a wrong list under a real-looking progress
// bar: a bank still in hash form, a bank scored at another depth, a question
// whose wording changed, a list with a hole the clone left. Each is a miss and
// nothing else.

const CUTOFFS = { depth: 2, deep: null, models: { m: 0.5 } };
const bank = (over: Partial<ReplayRetrieval> = {}): ReplayRetrieval => ({
  version: 1,
  form: "id",
  depth: 2,
  questions: {
    [textHash("which chunk?")]: { ids: ["a", "b"], scores: [0.9, 0.8], cutoffs: CUTOFFS },
    [textHash("holed?")]: { ids: ["a", null], scores: [0.9, 0.8], cutoffs: CUTOFFS },
  },
  ...over,
});

test("bankedRetrieval: a hit is the banked list, narrowed to strings", () => {
  assert.deepEqual(bankedRetrieval(bank(), "which chunk?", 2), {
    ids: ["a", "b"],
    scores: [0.9, 0.8],
    cutoffs: CUTOFFS,
  });
});

test("bankedRetrieval: a null in the list is a miss for that question only", () => {
  assert.equal(bankedRetrieval(bank(), "holed?", 2), null);
  assert.notEqual(bankedRetrieval(bank(), "which chunk?", 2), null);
});

test("bankedRetrieval: an edited wording, another depth, no bank, or hash form all miss", () => {
  assert.equal(bankedRetrieval(bank(), "which chunk? ", 2), null, "wording");
  assert.equal(bankedRetrieval(bank(), "which chunk?", 3), null, "depth");
  assert.equal(bankedRetrieval(null, "which chunk?", 2), null, "no bank");
  assert.equal(bankedRetrieval(bank({ form: "hash" }), "which chunk?", 2), null, "hash form");
});

test("textHash is the full sha256 hex the clone's _hash_scope computes", () => {
  // echo -n 'which chunk?' | shasum -a 256
  assert.equal(textHash("which chunk?").length, 64);
  assert.equal(textHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

const rec = (over: Partial<RetrievalRecord> = {}): RetrievalRecord => ({
  key: "k1",
  q: textHash("which chunk?"),
  depth: 2,
  ids: ["h-a", "h-b"],
  scores: [0.9, 0.8],
  cutoffs: CUTOFFS,
  ...over,
});

test("packRetrieval: merges lines by key in hash form, and agreeing duplicates collapse", () => {
  const { banks, contested } = packRetrieval([rec(), rec(), rec({ q: textHash("other?"), ids: ["h-c"], scores: [0.7] }), rec({ key: "k2" })]);
  assert.deepEqual([...banks.keys()].sort(), ["k1", "k2"]);
  assert.deepEqual(contested, []);
  const k1 = banks.get("k1")!;
  assert.equal(k1.form, "hash");
  assert.equal(k1.depth, 2);
  assert.equal(Object.keys(k1.questions).length, 2);
  assert.deepEqual(k1.questions[textHash("which chunk?")].ids, ["h-a", "h-b"]);
});

test("packRetrieval: same ranks with drifted scores keep the FIRST recording", () => {
  const { banks, contested } = packRetrieval([
    rec(),
    rec({ scores: [0.902, 0.798], cutoffs: { ...CUTOFFS, models: { m: 0.502 } } }),
  ]);
  assert.deepEqual(contested, []);
  assert.deepEqual(banks.get("k1")!.questions[textHash("which chunk?")].scores, [0.9, 0.8]);
});

test("packRetrieval: two different RANK lists under one (key, question) are contested and left out", () => {
  const { banks, contested } = packRetrieval([
    rec(),
    rec({ ids: ["h-b", "h-a"] }),
    rec(), // a third agreeing recording does not bring it back
    rec({ q: textHash("other?"), ids: ["h-c"], scores: [0.7] }),
  ]);
  assert.deepEqual(contested, [{ key: "k1", q: textHash("which chunk?") }]);
  assert.deepEqual(Object.keys(banks.get("k1")!.questions), [textHash("other?")]);
});

test("packRetrieval: a score drift past the tolerance, or another depth, is a key defect", () => {
  assert.throws(() => packRetrieval([rec(), rec({ depth: 3 })]), /depth/);
  // A drift of 0.05 on identical ranks is not embedding noise; it is contested.
  const { contested } = packRetrieval([rec(), rec({ scores: [0.95, 0.8] })]);
  assert.equal(contested.length, 1);
});
