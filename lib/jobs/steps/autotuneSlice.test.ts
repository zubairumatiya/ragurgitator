import assert from "node:assert/strict";
import test from "node:test";

import {
  drainStuck,
  leftWork,
  nextChunks,
  passSize,
  type PlanEntry,
  type QuestionState,
} from "@/lib/jobs/steps/autotuneSlice";

const plan: PlanEntry[] = [
  { chunkId: "a", questionIds: ["a1", "a2"] },
  { chunkId: "b", questionIds: ["b1"] },
  { chunkId: "c", questionIds: ["c1"] },
];

const state = (o: Record<string, QuestionState>) => new Map(Object.entries(o));

test("slice 2 still has work after slice 1 kept an override", () => {
  // THE regression test. Keeping one override on chunk a changes the global
  // retrieval fingerprint, so every question in the config except a's own — which
  // the search re-scored — is now stale. The old code asked prepareAutotune for
  // its chunk list, failingMetrics() returned [] for every stale question, and
  // slice 2 planned an empty sweep over a corpus with two untouched failing
  // chunks in it. The frozen plan cannot lose them.
  const decisions = nextChunks(
    plan,
    new Set(["a"]),
    state({ a1: "passing", a2: "passing", b1: "stale", c1: "stale" }),
  );
  assert.deepEqual(
    decisions.map((d) => [d.chunkId, d.action]),
    [
      ["b", "rescore"],
      ["c", "rescore"],
    ],
  );
});

test("a chunk a neighbour already fixed is covered, not work left", () => {
  // It must not be searched, and it must not be left out of the count either —
  // reporting it as unsearched is what makes a complete run offer "Run again"
  // forever once coverage is derived from searched vs total.
  const decisions = nextChunks(plan, new Set(), state({ a1: "passing", a2: "passing" }));
  assert.equal(decisions.find((d) => d.chunkId === "a")?.action, "skip");
});

test("stale beats failing, so a skip is never a guess", () => {
  // b1 is failing under a score computed against a retrieval state that no longer
  // exists. The chunk is worth visiting, but the honest first move is to find out.
  const decisions = nextChunks(plan, new Set(), state({ b1: "stale" }));
  assert.equal(decisions.find((d) => d.chunkId === "b")?.action, "rescore");

  const fresh = nextChunks(plan, new Set(), state({ b1: "failing" }));
  assert.equal(fresh.find((d) => d.chunkId === "b")?.action, "search");
});

test("a chunk with one stale and one fresh-passing question is still unknown", () => {
  const decisions = nextChunks(plan, new Set(), state({ a1: "passing", a2: "stale" }));
  assert.equal(decisions[0].action, "rescore");
});

test("a question that vanished stops being a reason to visit its chunk", () => {
  // Deleted or newly ignored. The chunk keeps its place in the frozen plan — the
  // ordering is frozen — but there is nothing left to tune on it.
  const decisions = nextChunks(plan, new Set(), state({ a1: "missing", a2: "missing" }));
  assert.equal(decisions[0].action, "skip");
});

test("the frozen order survives the filter", () => {
  // Worst-first is what makes stopEarly's cutoff cheap rather than arbitrary, and
  // a resumed run has to continue down the same ordering it was working through.
  const decisions = nextChunks(
    plan,
    new Set(),
    state({ a1: "failing", b1: "failing", c1: "failing" }),
  );
  assert.deepEqual(
    decisions.map((d) => d.chunkId),
    ["a", "b", "c"],
  );
});

test("every chunk covered means no decisions left", () => {
  assert.deepEqual(nextChunks(plan, new Set(["a", "b", "c"]), state({ b1: "failing" })), []);
});

// --- draining a set that re-screens itself ----------------------------------

test("a yielded slice is not a pass, so the stuck guard does not see it", () => {
  // THE §D.2 regression test. The streamed tail now hands back mid-set so the
  // driver can commit — 416 of 470 was one transaction's worth of re-score, and
  // splitting it is the fix. What must NOT follow is the next slice reading a
  // partial index as "this pass made no progress" and settling a corpus that is
  // still dirty. Only a slice that reached the end of the set records one.
  assert.equal(passSize(200, 470, null), null, "yielded at 200 of 470: not a pass");
  assert.equal(passSize(470, 470, null), 470, "drained the set: a pass");
  assert.equal(passSize(200, 470, 500), 500, "yielding never overwrites an earlier pass");
});

test("the stuck guard needs a complete pass to compare against", () => {
  // A first slice that yields has no previous pass, and 470 >= 470 would otherwise
  // read as "did not shrink" on the very first screen.
  assert.equal(drainStuck(470, null), false);
  assert.equal(drainStuck(470, 470), true, "a full pass that shrank nothing is stuck");
  assert.equal(drainStuck(12, 470), false, "shrinking is progress");
  assert.equal(drainStuck(480, 470), true, "growing is not progress either");
});

test("a set that drains to nothing is finished, not stuck", () => {
  // The order the phases check these in matters: an empty set is the SUCCESS
  // ending, and drainStuck(0, n) is false for any real n, so the two cannot
  // collide.
  assert.equal(drainStuck(0, 470), false);
});

// --- coverage ---------------------------------------------------------------

test("coverage is a subtraction, so a new way to stop short cannot fall off it", () => {
  // 'aborted' does not appear anywhere in leftWork. That is the point: the
  // allowlist it replaces would have had to be edited to know about it.
  for (const stopReason of ["budget", "cancelled", "aborted", null] as const) {
    assert.equal(
      leftWork({ chunksSearched: 12, chunksTotal: 74, stopReason }),
      true,
      `${stopReason} left 62 chunks unvisited`,
    );
  }
});

test("early stop is the one short run that is a success", () => {
  assert.equal(leftWork({ chunksSearched: 12, chunksTotal: 74, stopReason: "early" }), false);
});

test("a full sweep offers nothing to continue", () => {
  assert.equal(leftWork({ chunksSearched: 74, chunksTotal: 74, stopReason: null }), false);
  // Guards against a count that overshoots rather than falling short.
  assert.equal(leftWork({ chunksSearched: 75, chunksTotal: 74, stopReason: null }), false);
});
