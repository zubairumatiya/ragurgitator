// replayViewCore — phase 3 of docs/demo-cache-replay-plan.md.
//
// The claim this file exists to hold is a strong one: at full `n`, screened, the
// replayed leaderboard IS the master's own sweep — not an approximation of it and
// not the nearest banked checkpoint. Four properties carry that, and every one of
// them is invisible on a page that looks right:
//
//   1. `n` IS CONTINUOUS. Any n scores exactly the first n pairs in the master's
//      order, and the arithmetic over them is scoreFromSims — the same function
//      the real sweep calls. A leaderboard that rounded to a checkpoint would
//      look identical until someone compared it with a real run.
//   2. SCREENING IS WHAT ADMITS PAIRS. Before the screen the quarantined pairs
//      are scored under the generator's label (that is what unscreened MEANS);
//      after it they leave the pool, which is the same drop listPairs performs.
//      Get this backwards and the screen button becomes a no-op that reports a
//      number.
//   3. THE SHADOW HALF IS THE VISITOR'S. Only shadow pairs they hold a verdict
//      for enter the pool, under THEIR verdict — so judging a queued row moves
//      the leaderboard, which is the causal chain the whole plan turns on.
//   4. AVAILABILITY IS THE PUBLISH'S. The demo carries one provider's key, so a
//      row rebuilt against the visitor's own providers would blank ten of eleven
//      models that have real numbers behind them.
import assert from "node:assert/strict";
import test from "node:test";

import { packMatrix, type ReplayMatrix, type ReplayPair } from "@/lib/demo/replayCore";
import {
  replayPairFloor,
  replaySweep,
  selectReplay,
} from "@/lib/demo/replayViewCore";
import { scoreFromSims, type PairLabelLike } from "@/lib/rag/keyModelSweepCore";
import type { EffectiveAcceptTarget } from "@/lib/rag/semanticCache";

// Two REGISTERED models, so the rows carry real dimensions and providers, plus
// one the publish could not score.
const MODELS = ["voyage-4-lite", "text-embedding-3-small", "embed-v4"];

const TARGET: EffectiveAcceptTarget = {
  target: 0.9,
  source: "config",
  configId: "cfg",
  configLabel: "Default",
};

const gen = (hash: string, label: PairLabelLike, quarantined = false): ReplayPair => ({
  hash,
  label,
  source: "generated",
  difficulty: label === "same" ? "paraphrase" : "hard-negative",
  quarantined,
});

const shadow = (hash: string, label: PairLabelLike): ReplayPair => ({
  hash,
  label,
  source: "shadow",
  origin: "traffic",
  difficulty: null,
  // A shadow row is never quarantined — the quarantine is a verdict on a
  // GENERATED pair's label — but the field is not optional, so it is stated.
  quarantined: false,
});

// Six pairs in the master's order, generated and shadow interleaved — the
// interleaving matters, because "the first n generated" is not "the first n rows"
// and a selection that confused the two would still pass on a sorted matrix.
const PAIRS: ReplayPair[] = [
  gen("g1", "same"),
  shadow("s1", "same"),
  gen("g2", "different"),
  gen("g3", "same", true),
  shadow("s2", "different"),
  gen("g4", "different"),
];

// A separable set: `same` pairs score high, `different` pairs low, so τ exists
// and recall is a number rather than null.
const SIMS = [0.97, 0.95, 0.40, 0.93, 0.30, 0.35];

const matrix = (over: Partial<ReplayMatrix> = {}): ReplayMatrix =>
  packMatrix({
    models: MODELS,
    pairs: PAIRS,
    // The third model never scored — an unreachable provider at publish time.
    sims: [SIMS, SIMS.map((s) => s - 0.05), null],
    target: 0.9,
    minSamples: 2,
    ...over,
  });

const noShadow = new Map<string, PairLabelLike>();
const bothShadow = new Map<string, PairLabelLike>([
  ["s1", "same"],
  ["s2", "different"],
]);

test("n is continuous — the selection is the first n GENERATED pairs, in the master's order", () => {
  const m = matrix();
  for (const [n, expected] of [
    [0, []],
    [1, ["g1"]],
    [2, ["g1", "g2"]],
    [3, ["g1", "g2", "g3"]],
    [9, ["g1", "g2", "g3", "g4"]],
  ] as const) {
    const sel = selectReplay(m, { generated: n, screened: false }, noShadow);
    assert.deepEqual(
      sel.rows.map((r) => m.pairs[r.index].hash),
      expected,
      `n=${n}`,
    );
  }
});

test("the counts line reports the pairs reached, with the quarantine withheld until the screen", () => {
  const m = matrix();
  const before = selectReplay(m, { generated: 4, screened: false }, noShadow).bank;
  assert.deepEqual(before, {
    total: 4,
    same: 2,
    different: 2,
    // Nothing yet: the quarantine is what the screen DISCOVERS, and printing it
    // first would make the button a no-op that reports a number.
    quarantined: 0,
    unscreened: 4,
    remaining: 0,
  });

  const after = selectReplay(m, { generated: 4, screened: true }, noShadow).bank;
  // `total` still counts the quarantined pair — pairStats counts the same way,
  // because a quarantined pair is still generated and still occupies its origin
  // question; it is simply no longer scored.
  assert.deepEqual(after, {
    total: 4,
    same: 2,
    different: 2,
    quarantined: 1,
    unscreened: 0,
    remaining: 0,
  });
});

test("screening drops the quarantined pair from the scored pool, and that moves the numbers", () => {
  const m = matrix();
  const before = selectReplay(m, { generated: 4, screened: false }, noShadow);
  const after = selectReplay(m, { generated: 4, screened: true }, noShadow);
  assert.deepEqual(before.rows.map((r) => m.pairs[r.index].hash), ["g1", "g2", "g3", "g4"]);
  assert.deepEqual(after.rows.map((r) => m.pairs[r.index].hash), ["g1", "g2", "g4"]);
  assert.equal(before.pairs.total, 4);
  assert.equal(after.pairs.total, 3);
});

test("the shadow half is the visitor's — unjudged rows are absent, and a verdict is theirs", () => {
  const m = matrix();
  const none = selectReplay(m, { generated: 4, screened: true }, noShadow);
  assert.equal(none.pairs.shadow, 0);

  const held = selectReplay(m, { generated: 4, screened: true }, bothShadow);
  assert.equal(held.pairs.shadow, 2);
  assert.equal(held.pairs.generated, 3);
  assert.equal(held.pairs.total, 5);

  // The label is the VISITOR's verdict, not the matrix's. A guest who judges s2
  // the other way scores it the other way, which is what makes hand judging move
  // the leaderboard rather than decorate it.
  // Held as judged (s1 same, s2 different): g1 and s1 are the accepts.
  assert.equal(held.pairs.same, 2);
  const flipped = selectReplay(
    m,
    { generated: 4, screened: true },
    new Map<string, PairLabelLike>([
      ["s1", "same"],
      ["s2", "same"],
    ]),
  );
  assert.equal(flipped.pairs.same, 3);
  assert.equal(flipped.pairs.different, 2);
});

test("a leaderboard row is scoreFromSims over the selected column — the sweep's own arithmetic", () => {
  const m = matrix();
  const sel = selectReplay(m, { generated: 2, screened: true }, bothShadow);
  const sweep = replaySweep(m, sel, TARGET);
  const row = sweep.rows.find((r) => r.model === "voyage-4-lite")!;

  // Computed independently, exactly as scoreModel would over the same four pairs.
  const expected = scoreFromSims(
    sel.rows.map((r) => ({ sim: SIMS[r.index], label: r.label })),
    0.9,
    2,
  );
  assert.equal(row.pairsScored, 4);
  assert.equal(row.threshold, expected.threshold);
  assert.equal(row.recallAtThreshold, expected.recall);
  assert.equal(row.precisionAtThreshold, expected.precision);
  assert.equal(row.auc, expected.aucValue);
  assert.deepEqual(row.calibration, expected.calibration);
});

test("the target and minSamples are the MATRIX's, and targetSource still names the visitor's config", () => {
  // A workspace whose dial has been moved must not restate what the master
  // measured — the arithmetic is the publish's, the attribution is theirs.
  const sweep = replaySweep(
    matrix(),
    selectReplay(matrix(), { generated: 4, screened: true }, bothShadow),
    { ...TARGET, target: 0.5 },
  );
  assert.equal(sweep.target, 0.9);
  assert.equal(sweep.targetSource.target, 0.9);
  assert.equal(sweep.targetSource.configLabel, "Default");
  assert.equal(sweep.minSamples, 2);
  assert.equal(sweep.cancelled, false);
});

test("a model the publish never scored is reported, not dropped — and never as a zero", () => {
  const m = matrix();
  const sweep = replaySweep(m, selectReplay(m, { generated: 4, screened: true }, bothShadow), TARGET);
  assert.equal(sweep.rows.length, MODELS.length);
  const unscored = sweep.rows.find((r) => r.model === "embed-v4")!;
  assert.equal(unscored.available, false);
  assert.equal(unscored.reason, "not scored in this build");
  assert.equal(unscored.threshold, null);
  assert.equal(unscored.auc, null);
  assert.equal(unscored.pairsScored, 0);
  // Availability is the PUBLISH's, so the two models the master did score stay
  // available however few providers the visitor's own workspace can reach.
  assert.deepEqual(
    sweep.rows.filter((r) => r.available).map((r) => r.model).sort(),
    ["text-embedding-3-small", "voyage-4-lite"],
  );
});

test("rows are ranked by recall@τ then AUC, as runKeyModelSweep ranks them", () => {
  const m = matrix();
  const sweep = replaySweep(m, selectReplay(m, { generated: 4, screened: true }, bothShadow), TARGET);
  const rank = sweep.rows.map((r) => r.recallAtThreshold ?? -1);
  assert.deepEqual(rank, [...rank].sort((a, b) => b - a));
  // The unmeasured model sorts last: "couldn't be measured" must never outrank a
  // measured result.
  assert.equal(sweep.rows.at(-1)!.model, "embed-v4");
});

test("an empty selection leaves every row unscored rather than perfect", () => {
  const m = matrix();
  const sweep = replaySweep(m, selectReplay(m, { generated: 0, screened: false }, noShadow), TARGET);
  assert.deepEqual(
    sweep.rows.filter((r) => r.reason === "no pairs to score").map((r) => r.model).sort(),
    ["text-embedding-3-small", "voyage-4-lite"],
  );
  assert.equal(sweep.pairs.total, 0);
});

test("the pair-bank floor is the max cosine among the GENERATED hard negatives reached", () => {
  const m = matrix();
  // g2 (0.40) and g4 (0.35) are the different-labeled generated pairs; s2 is
  // rejected traffic and belongs to the traffic population, not this one.
  const full = replayPairFloor(m, selectReplay(m, { generated: 4, screened: true }, bothShadow), "voyage-4-lite");
  assert.deepEqual(full, { floor: 0.4, comparisons: 2, missingVectors: 0 });

  // It subsets with `n` like everything else: at n=1 there is no hard negative
  // yet, and an empty population is a real answer rather than a zero.
  const early = replayPairFloor(m, selectReplay(m, { generated: 1, screened: true }, bothShadow), "voyage-4-lite");
  assert.deepEqual(early, { floor: null, comparisons: 0, missingVectors: 0 });
});

test("a floor under a model the publish never scored reports the gap instead of a number", () => {
  const m = matrix();
  const sel = selectReplay(m, { generated: 4, screened: true }, bothShadow);
  // The floor is a MAX, so a pair with no banked cosine could only ever have
  // raised it — which is exactly what missingVectors says on a real account.
  assert.deepEqual(replayPairFloor(m, sel, "embed-v4"), {
    floor: null,
    comparisons: 0,
    missingVectors: 2,
  });
  assert.deepEqual(replayPairFloor(m, sel, "not-a-model"), {
    floor: null,
    comparisons: 0,
    missingVectors: 2,
  });
});
