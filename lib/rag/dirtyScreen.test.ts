// Tests for the pure dirty screen (dirtyScreen.ts) — the decision core of the
// post-autotune dirty-set re-score. Everything here is arithmetic on
// precomputed sims, so no DB or provider is involved.
import assert from "node:assert/strict";
import { test } from "node:test";

import { screenStoredResult, type ChangedChunkSims } from "./dirtyScreen";

const BASE = "voyage-3";
const ALT = "text-embedding-3-small";
const START = "start-fingerprint";

// A result scored under the run-start state at depth 10, with room below the
// cutoffs: base-space top-depth cutoff .80, alt-space cutoff .75, deep .40.
const baseArgs = () => ({
  depth: 10,
  baseModel: BASE,
  startState: START,
  retrievalState: START,
  editStale: false,
  retrievedIds: ["c1", "c2", "c3"],
  cutoffs: { depth: 10, deep: 0.4, models: { [BASE]: 0.8, [ALT]: 0.75 } },
  changed: [] as ChangedChunkSims[],
});

// A newly-overridden chunk (alt model) far from the question in every space.
const farNewOverride = (): ChangedChunkSims => ({
  chunkId: "x1",
  finalModel: ALT,
  startOverridden: false,
  baseSim: 0.1,
  bestPieceSim: 0.1,
});

test("everything comfortably below the cutoffs is clean", () => {
  assert.equal(
    screenStoredResult({ ...baseArgs(), changed: [farNewOverride()] }),
    "clean",
  );
});

test("results not from the run-start state are dirty (mid-run, stale, or pre-0022)", () => {
  const changed = [farNewOverride()];
  assert.equal(
    screenStoredResult({ ...baseArgs(), changed, retrievalState: "mid-run-state" }),
    "dirty",
  );
  assert.equal(
    screenStoredResult({ ...baseArgs(), changed, retrievalState: null }),
    "dirty",
  );
});

test("edit-stale, missing cutoffs, and depth drift are dirty", () => {
  const changed = [farNewOverride()];
  assert.equal(screenStoredResult({ ...baseArgs(), changed, editStale: true }), "dirty");
  assert.equal(screenStoredResult({ ...baseArgs(), changed, cutoffs: null }), "dirty");
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed,
      cutoffs: { ...baseArgs().cutoffs, depth: 15 },
    }),
    "dirty",
  );
});

test("screen 1: a changed chunk inside the stored retrieved list is dirty", () => {
  const x = { ...farNewOverride(), chunkId: "c2" };
  assert.equal(screenStoredResult({ ...baseArgs(), changed: [x] }), "dirty");
});

test("screen 2: new pieces at/above the model-space depth cutoff are dirty (≥, ties count)", () => {
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [{ ...farNewOverride(), bestPieceSim: 0.9 }],
    }),
    "dirty",
  );
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [{ ...farNewOverride(), bestPieceSim: 0.75 }],
    }),
    "dirty",
  );
});

test("screen 2: unknowable sims never pass — missing model cutoff or piece sim is dirty", () => {
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [{ ...farNewOverride(), finalModel: "brand-new-model" }],
    }),
    "dirty",
  );
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [{ ...farNewOverride(), bestPieceSim: null }],
    }),
    "dirty",
  );
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [{ ...farNewOverride(), baseSim: null }],
    }),
    "dirty",
  );
});

test("screen 3: a first-time override inside the deep list dirties fused results only", () => {
  const inDeepList = { ...farNewOverride(), baseSim: 0.5 }; // ≥ deep (.40)
  assert.equal(screenStoredResult({ ...baseArgs(), changed: [inDeepList] }), "dirty");
  // Same chunk, but the result was scored under 'baseline' → no pools existed.
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      startState: "baseline",
      retrievalState: "baseline",
      changed: [inDeepList],
    }),
    "clean",
  );
  // Already overridden at start → base-lane membership didn't change.
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [{ ...inDeepList, startOverridden: true }],
    }),
    "clean",
  );
});

test("screen 3: an unfilled deep list (deep null) can't prove anything for fused results", () => {
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      cutoffs: { ...baseArgs().cutoffs, deep: null },
      changed: [farNewOverride()],
    }),
    "dirty",
  );
});

test("cleared chunk: clean only when below BOTH the base top-depth and deep cutoffs", () => {
  const cleared = (baseSim: number): ChangedChunkSims => ({
    chunkId: "x1",
    finalModel: null,
    startOverridden: true,
    baseSim,
    bestPieceSim: null,
  });
  assert.equal(screenStoredResult({ ...baseArgs(), changed: [cleared(0.1)] }), "clean");
  assert.equal(screenStoredResult({ ...baseArgs(), changed: [cleared(0.5)] }), "dirty"); // in deep list
  assert.equal(screenStoredResult({ ...baseArgs(), changed: [cleared(0.85)] }), "dirty"); // enters top-depth
});

test("one dirty chunk among several clean ones dirties the question", () => {
  assert.equal(
    screenStoredResult({
      ...baseArgs(),
      changed: [farNewOverride(), { ...farNewOverride(), chunkId: "x2", bestPieceSim: 0.99 }],
    }),
    "dirty",
  );
});

test("no changed chunks: freshness is decided by state alone", () => {
  assert.equal(screenStoredResult({ ...baseArgs(), changed: [] }), "clean");
  assert.equal(
    screenStoredResult({ ...baseArgs(), changed: [], retrievalState: "other" }),
    "dirty",
  );
});
