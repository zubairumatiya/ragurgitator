// Contract tests for the ranking metrics in evalMetrics.ts. These pin the nDCG
// behavior the /eval dashboard relies on: a perfect retrieval scores 1, a worse
// order scores less, chunks outside the ideal set never help, and an absent
// ideal ranking is null (ungraded) rather than a misleading number.
//
// Run with: pnpm test
// (Node's built-in test runner, with tsx resolving the extensionless import.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { reciprocalRank, ndcg } from "./evalMetrics";

test("reciprocalRank: 1/rank, 0 on a miss", () => {
  assert.equal(reciprocalRank(1), 1);
  assert.equal(reciprocalRank(2), 0.5);
  assert.equal(reciprocalRank(null), 0);
});

test("ndcg: perfect order scores 1", () => {
  const ideal = ["a", "b", "c"];
  assert.equal(ndcg(ideal, ["a", "b", "c"], 3), 1);
});

test("ndcg: a worse order scores strictly between 0 and 1", () => {
  const ideal = ["a", "b", "c"];
  const score = ndcg(ideal, ["c", "b", "a"], 3);
  assert.ok(score !== null && score > 0 && score < 1, `got ${score}`);
});

test("ndcg: no ideal ranking is null (ungraded)", () => {
  assert.equal(ndcg([], ["a", "b"], 5), null);
});

test("ndcg: retrieved chunks outside the ideal set contribute 0 gain", () => {
  const ideal = ["a", "b"];
  // A distractor at rank 1 pushes the relevant chunks down — must score < 1.
  const withDistractor = ndcg(ideal, ["x", "a", "b"], 3);
  const perfect = ndcg(ideal, ["a", "b"], 3);
  assert.ok(withDistractor !== null && withDistractor < (perfect ?? 1));
  // An all-distractor retrieval has zero gain → 0.
  assert.equal(ndcg(ideal, ["x", "y", "z"], 3), 0);
});

test("ndcg: only the top-k of the retrieved order counts", () => {
  const ideal = ["a", "b", "c"];
  // The relevant chunks all sit beyond k=2, so nDCG@2 is 0 even though they're
  // present further down.
  assert.equal(ndcg(ideal, ["x", "y", "a", "b", "c"], 2), 0);
});
