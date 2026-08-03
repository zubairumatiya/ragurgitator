// Contract tests for the OFFLINE REPLAY's arithmetic (lib/rag/replayMetrics).
//
// Every number on Appraise → Models rests on these two functions, and a bug in
// either produces plausible-looking metrics rather than an error — a model could
// be ranked above another on a silently wrong MRR. The DB half isn't covered
// here; these are the pure parts, so they run without a DATABASE_URL.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { goldRank, summarizeRanks } from "./replayMetrics";

// A tiny 2-D "embedding space". Cosine ignores magnitude, so direction is all
// that matters and these are easy to reason about by hand.
const vec = (x: number, y: number) => [x, y];

test("goldRank: 1 when nothing in the pool beats the gold chunk", () => {
  const query = vec(1, 0);
  const gold = vec(1, 0); // identical direction — cosine 1, unbeatable
  const pool = [
    { text: "gold", vec: gold },
    { text: "a", vec: vec(0, 1) },
    { text: "b", vec: vec(-1, 0) },
  ];
  assert.equal(goldRank(query, gold, pool, "gold"), 1);
});

test("goldRank: counts exactly the chunks that outscore the gold one", () => {
  const query = vec(1, 0);
  const gold = vec(1, 1); // cosine ≈ 0.707
  const pool = [
    { text: "gold", vec: gold },
    { text: "better", vec: vec(1, 0.1) }, // ≈ 0.995 — beats gold
    { text: "alsoBetter", vec: vec(1, 0.2) }, // ≈ 0.980 — beats gold
    { text: "worse", vec: vec(0, 1) }, // 0 — doesn't
  ];
  assert.equal(goldRank(query, gold, pool, "gold"), 3);
});

test("goldRank: the gold chunk never counts as beating itself", () => {
  // The pool ALWAYS contains the gold chunk (it's a corpus chunk). If the
  // self-comparison weren't skipped every rank would be inflated by one, which
  // would look like a uniformly slightly-worse model rather than a bug.
  const query = vec(1, 0);
  const gold = vec(1, 0);
  const pool = [{ text: "gold", vec: gold }];
  assert.equal(goldRank(query, gold, pool, "gold"), 1);
});

test("goldRank: an exact tie leaves the gold chunk ahead", () => {
  // Strictly-greater comparison. Ties are near-impossible between real float
  // vectors, but the result must not depend on pool ordering if one happens.
  const query = vec(1, 0);
  const gold = vec(2, 0); // same direction as the tie, cosine 1 for both
  const pool = [
    { text: "gold", vec: gold },
    { text: "tie", vec: vec(5, 0) },
  ];
  assert.equal(goldRank(query, gold, pool, "gold"), 1);
});

test("summarizeRanks: recall@k counts ranks at or below k", () => {
  const m = summarizeRanks([1, 2, 4, 11]);
  assert.equal(m.questions, 4);
  assert.equal(m.recallAt1, 0.25); // rank 1
  assert.equal(m.recallAt3, 0.5); // ranks 1, 2
  assert.equal(m.recallAt5, 0.75); // ranks 1, 2, 4
  assert.equal(m.recallAt10, 0.75); // 11 is outside
});

test("summarizeRanks: MRR is the mean reciprocal rank", () => {
  const m = summarizeRanks([1, 2]);
  assert.equal(m.mrr, (1 + 0.5) / 2);
  assert.equal(summarizeRanks([1, 1, 1]).mrr, 1);
});

test("summarizeRanks: recall@k is monotonic in k", () => {
  // A wider cut can never retrieve less. Cheap invariant, and it would catch an
  // off-by-one in the threshold comparison that the fixed cases above might not.
  const m = summarizeRanks([1, 3, 3, 6, 9, 25]);
  assert.ok(m.recallAt1! <= m.recallAt3!);
  assert.ok(m.recallAt3! <= m.recallAt5!);
  assert.ok(m.recallAt5! <= m.recallAt10!);
});

test("summarizeRanks: no questions scored yields nulls, not zeros", () => {
  // A model that couldn't be scored must render "—". Zeros would read as "this
  // model retrieved nothing", which is a claim about the model rather than
  // about our missing data.
  const m = summarizeRanks([]);
  assert.equal(m.questions, 0);
  assert.equal(m.mrr, null);
  assert.equal(m.recallAt1, null);
  assert.equal(m.recallAt10, null);
});
