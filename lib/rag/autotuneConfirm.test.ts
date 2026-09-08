// The keep/revert rule both the real search and the replayed install confirm
// against (docs/demo-voyage-tuning-plan.md §3.5). Each case is one clause of
// applyAutotuneCandidate's original condition, so a change here that flips one
// is a change to what an autotune run keeps.
import assert from "node:assert/strict";
import test from "node:test";

import { confirmVerdict } from "@/lib/rag/autotuneConfirm";

const set = (...pairs: string[]) => new Set(pairs);

test("a shrunken failing set with no new failure is kept in either mode", () => {
  const before = set("q1:mrr", "q2:recall");
  assert.deepEqual(confirmVerdict(before, set("q1:mrr"), 0.5, 1.5, "clear"), {
    keep: true,
    reason: "shrank",
  });
  assert.deepEqual(confirmVerdict(before, set(), 0.5, 2, "improve"), { keep: true, reason: "shrank" });
});

test("a NEW failing pair reverts even when the set shrank", () => {
  const before = set("q1:mrr", "q2:recall");
  assert.deepEqual(confirmVerdict(before, set("q3:mrr"), 0.5, 2, "improve"), {
    keep: false,
    reason: "new-failure",
  });
});

test("same size, values rose: kept only under keep-best", () => {
  const before = set("q1:mrr");
  assert.deepEqual(confirmVerdict(before, set("q1:mrr"), 0.25, 0.5, "improve"), {
    keep: true,
    reason: "rose",
  });
  assert.deepEqual(confirmVerdict(before, set("q1:mrr"), 0.25, 0.5, "clear"), {
    keep: false,
    reason: "no-progress",
  });
});

test("same size, values flat or lower: reverted in either mode", () => {
  const before = set("q1:mrr");
  assert.equal(confirmVerdict(before, set("q1:mrr"), 0.5, 0.5, "improve").keep, false);
  assert.equal(confirmVerdict(before, set("q1:mrr"), 0.5, 0.25, "improve").keep, false);
  // The published winner that "did not move this workspace's question" — §0's
  // table, rows 48b4da and b290c6 on the easy question.
  assert.deepEqual(confirmVerdict(before, set("q1:mrr"), 0.2, 0.2, "improve"), {
    keep: false,
    reason: "no-progress",
  });
});

test("a rise inside floating-point noise is not a rise", () => {
  assert.equal(confirmVerdict(set("q1:mrr"), set("q1:mrr"), 0.5, 0.5 + 1e-12, "improve").keep, false);
});
