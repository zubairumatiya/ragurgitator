// selectProbes — the only branching logic in probe replay that does not need a
// database, and the one whose failure mode is silent: a sample that is all
// paraphrases, or all variants of one question, still produces a full queue and a
// useless one.
import assert from "node:assert/strict";
import test from "node:test";

import { PROBE_CAP, selectProbes, type ProbePair } from "@/lib/rag/probeReplayCore";

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
