// Contract tests for the partition (lib/rag/evalRates.ts).
//
// The rule these exist to pin down is the one that is easiest to get subtly
// wrong and impossible to notice afterwards: `ignored` is a UNION of a human's
// "ignore in rates" click and the holdout draw's own rows, and the two must come
// apart in opposite directions. A human ignore belongs to NEITHER side; a drawn
// question belongs to the holdout ONLY. Collapse either and the generalization
// number is quietly measured over the wrong set — with no error, no dash, and no
// way to tell from the rendered number.
import { test } from "node:test";
import assert from "node:assert/strict";

import { type RateRow, reduceRates, splitRates, splitRatesFor } from "./evalRates";

// A scored hit by default; each test states only the fields it is about.
function row(id: string, over: Partial<RateRow> = {}): RateRow {
  return {
    questionId: id,
    hit: true,
    editStale: false,
    rr: 1,
    ndcg: 1,
    ignored: false,
    heldOut: false,
    ...over,
  };
}

// A holdout row as the DRAW writes it: ignored AND heldOut. Nothing in the app
// produces heldOut without ignored — the draw's rows live in
// config_question_ignores — so a fixture that sets only heldOut would be testing
// a state the database cannot hold.
const held = (id: string, over: Partial<RateRow> = {}) =>
  row(id, { ignored: true, heldOut: true, ...over });

test("a human ignore is excluded from BOTH sides", () => {
  const rows = [
    row("train-hit"),
    row("human-ignored", { ignored: true, hit: false }),
    held("held-miss", { hit: false, rr: 0, ndcg: 0 }),
  ];
  const { train, holdout } = splitRates(rows);

  // The human's row is a miss. If it leaked into either side, that side's recall
  // would drop below 1 / rise above 0 respectively.
  assert.equal(train.n, 1);
  assert.equal(train.recall, 1);
  assert.equal(holdout.n, 1);
  assert.equal(holdout.recall, 0);
});

test("a drawn question lands in holdout only, never in train", () => {
  const rows = [row("a"), row("b"), held("h1"), held("h2")];
  const { train, holdout } = splitRates(rows);
  assert.equal(train.n, 2);
  assert.equal(holdout.n, 2);
});

test("the headline partition is the train side", () => {
  // `rated` is what getSummary reduces for the numbers above the fold, and it
  // has to be the same set as `train` — otherwise the section's "train" column
  // silently disagrees with the card it sits under.
  const rows = [row("a"), row("b", { hit: false, rr: 0 }), held("h")];
  const rated = reduceRates(rows, "rated");
  const trained = reduceRates(rows, "train");
  assert.equal(rated.recall, trained.recall);
  assert.equal(rated.scoredRows.length, trained.scoredRows.length);
});

test("unscored and edit-stale rows are pending on both sides, not misses", () => {
  const rows = [
    row("scored"),
    row("never-scored", { hit: null }),
    row("edited", { editStale: true, hit: false }),
    held("h-scored"),
    held("h-never", { hit: null }),
    held("h-edited", { editStale: true, hit: false }),
  ];
  const { train, holdout } = splitRates(rows);
  assert.equal(train.n, 1);
  assert.equal(train.recall, 1);
  assert.equal(holdout.n, 1);
  assert.equal(holdout.recall, 1);
});

test("nDCG averages only the graded rows of its own side", () => {
  const rows = [
    row("a", { ndcg: 0.5 }),
    row("b", { ndcg: null }), // ungraded: absent, not a zero
    held("h", { ndcg: 0.25 }),
  ];
  const train = reduceRates(rows, "train");
  const holdout = reduceRates(rows, "holdout");
  assert.equal(train.ndcg, 0.5);
  assert.equal(train.ndcgCovered, 1);
  assert.equal(holdout.ndcg, 0.25);
  assert.equal(holdout.ndcgCovered, 1);
});

test("an empty side reports null rates, not zero", () => {
  const { holdout } = splitRates([row("a")]);
  assert.equal(holdout.n, 0);
  assert.equal(holdout.recall, null);
  assert.equal(holdout.mrr, null);
  assert.equal(holdout.ndcg, null);
});

// --- splitRatesFor: a run's numbers are over the set it FROZE ---------------

test("a question released from the holdout mid-run still counts as held out", () => {
  const frozen = new Set(["h"]);
  // The draw has since let "h" go: it is no longer ignored and no longer flagged.
  const rows = [row("a"), row("h", { hit: false, rr: 0 })];
  const { train, holdout } = splitRatesFor(rows, frozen);

  assert.equal(holdout.n, 1, "the frozen member must stay on the holdout side");
  assert.equal(holdout.recall, 0);
  // …and must not ALSO be counted in train, which is what reading the live
  // `ignored` flag would do.
  assert.equal(train.n, 1);
  assert.equal(train.recall, 1);
});

test("a question drawn into the holdout mid-run counts on neither side", () => {
  const rows = [row("a"), held("newcomer", { hit: false, rr: 0 })];
  const { train, holdout } = splitRatesFor(rows, new Set(["a"]));
  assert.equal(holdout.n, 1); // just "a"
  assert.equal(train.n, 0);
});

test("splitRatesFor does not mutate the rows it is given", () => {
  const rows = [row("h")];
  splitRatesFor(rows, new Set(["h"]));
  assert.equal(rows[0].heldOut, false);
  assert.equal(rows[0].ignored, false);
});
