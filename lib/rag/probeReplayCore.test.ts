// selectProbes — the only branching logic in probe replay that does not need a
// database, and the one whose failure mode is silent: a sample that is all
// paraphrases, or all variants of one question, still produces a full queue and a
// useless one.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROBE_CAP,
  PROBE_LOOKUP,
  selectProbes,
  type ProbePair,
} from "@/lib/rag/probeReplayCore";

const pair = (
  pairId: string,
  originQuestionId: string,
  difficulty: "hard-negative" | "paraphrase",
): ProbePair => ({
  pairId,
  originQuestionId,
  originText: `origin ${originQuestionId}`,
  variantText: `variant ${pairId}`,
  difficulty,
});

test("selectProbes: hard negatives come first", () => {
  const chosen = selectProbes([
    pair("p1", "q1", "paraphrase"),
    pair("p2", "q2", "hard-negative"),
    pair("p3", "q3", "paraphrase"),
    pair("p4", "q4", "hard-negative"),
  ]);
  assert.deepEqual(
    chosen.map((p) => p.difficulty),
    ["hard-negative", "hard-negative", "paraphrase", "paraphrase"],
  );
});

test("selectProbes: every origin question is represented before any is repeated", () => {
  // Three variants of q1 and one of q2. Under a naive sort by difficulty then id,
  // q2 would come last; the spread rule has to pull it forward.
  const chosen = selectProbes(
    [
      pair("p1", "q1", "hard-negative"),
      pair("p2", "q1", "hard-negative"),
      pair("p3", "q1", "hard-negative"),
      pair("p4", "q2", "hard-negative"),
    ],
    2,
  );
  assert.deepEqual(
    chosen.map((p) => p.originQuestionId),
    ["q1", "q2"],
  );
});

test("selectProbes: repeats fill the cap once every origin has one", () => {
  const chosen = selectProbes(
    [
      pair("p1", "q1", "hard-negative"),
      pair("p2", "q1", "hard-negative"),
      pair("p3", "q2", "hard-negative"),
    ],
    3,
  );
  assert.deepEqual(
    chosen.map((p) => p.pairId),
    ["p1", "p3", "p2"],
  );
});

test("selectProbes: the cap is a hard bound", () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    pair(`p${String(i).padStart(3, "0")}`, `q${i}`, "hard-negative"),
  );
  assert.equal(selectProbes(many).length, PROBE_CAP);
  assert.equal(selectProbes(many, 7).length, 7);
});

test("selectProbes: deterministic — the same input yields the same order", () => {
  const pairs = [
    pair("p3", "q2", "paraphrase"),
    pair("p1", "q1", "hard-negative"),
    pair("p2", "q1", "paraphrase"),
  ];
  assert.deepEqual(selectProbes(pairs), selectProbes([...pairs].reverse()));
});

test("selectProbes: does not mutate its input", () => {
  const pairs = [pair("p2", "q2", "paraphrase"), pair("p1", "q1", "hard-negative")];
  const before = pairs.map((p) => p.pairId);
  selectProbes(pairs);
  assert.deepEqual(
    pairs.map((p) => p.pairId),
    before,
  );
});

// --- the rails (docs/probe-replay-plan.md, Phase 4) ---------------------------
//
// PROBE_LOOKUP is the whole of rails 1 and 3 that can be checked without a
// database, and it is the half worth checking anyway: the failure mode of every
// key here is silence. A probe that served would bank the variant it replayed and
// the next pass would self-match it at cosine 1.0; a probe stamped `traffic`
// would enter the live threshold recommendation and §4's pool. Neither shows up
// as an error — only as numbers that have quietly stopped meaning anything.
//
// The rest of those rails is a property of the RUNTIME (no verdict column is
// ever written, semantic_cache gains no row), which needs a live database. That
// half is scripts/guards.ts sweep 7 plus the integration tier, not this file.

test("PROBE_LOOKUP: never serves — the parameter whose loss poisons the cache", () => {
  assert.equal(PROBE_LOOKUP.serve, false);
});

test("PROBE_LOOKUP: probes at floor 0 and stamps origin 'probe'", () => {
  // floor 0 because a probe pass chooses its own floor. origin 'probe' because
  // that is what keeps these rows out of the live recommendation (0069) and out
  // of the key-model sweep's pool (see keyModelSweepCore.test.ts).
  assert.deepEqual(PROBE_LOOKUP.shadow, { floor: 0, origin: "probe" });
});

test("PROBE_LOOKUP: takes the live threshold and key model, inventing neither", () => {
  // A probe is supposed to measure what the cache WOULD do, and eligibility was
  // computed against the live key model — a probe under a different one would be
  // scored against a candidate set it was never selected from.
  assert.equal(PROBE_LOOKUP.threshold, null);
  assert.equal(PROBE_LOOKUP.keyModel, null);
});

test("PROBE_LOOKUP: carries nothing else — an unlisted key is an unreviewed one", () => {
  // Pinned as a whole rather than key by key, so ADDING an option is a test
  // failure too. Every option on this call is a decision about what a probe is
  // allowed to do, and one arriving without a rail is how the next silent
  // parameter gets in.
  assert.deepEqual(Object.keys(PROBE_LOOKUP).sort(), [
    "keyModel",
    "serve",
    "shadow",
    "threshold",
  ]);
});
