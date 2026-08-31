import assert from "node:assert/strict";
import { test } from "node:test";

import { withCandidateSims } from "./overrideSimMerge";

test("candidate sims collapse to the max, like the old JS piece loop", () => {
  const merged = withCandidateSims(new Map(), "c1", [0.1, 0.7, 0.4]);
  assert.equal(merged.get("c1"), 0.7);
});

test("a stored sim for the SAME chunk still competes by max", () => {
  // The trial path excludes the chunk's own stored override in SQL, but a
  // caller that did not would still have to see max(stored, candidate).
  assert.equal(withCandidateSims(new Map([["c1", 0.9]]), "c1", [0.5]).get("c1"), 0.9);
  assert.equal(withCandidateSims(new Map([["c1", 0.3]]), "c1", [0.5]).get("c1"), 0.5);
});

test("other chunks' SQL sims pass through untouched", () => {
  const stored = new Map([
    ["c1", 0.9],
    ["c2", 0.2],
  ]);
  const merged = withCandidateSims(stored, "c3", [0.5]);
  assert.deepEqual([...merged.entries()].sort(), [
    ["c1", 0.9],
    ["c2", 0.2],
    ["c3", 0.5],
  ]);
});

test("no candidate vectors leaves the SQL map alone", () => {
  const stored = new Map([["c1", 0.9]]);
  assert.deepEqual([...withCandidateSims(stored, "c1", []).entries()], [["c1", 0.9]]);
});

test("the stored map is not mutated — rungs share it", () => {
  const stored = new Map([["c1", 0.4]]);
  withCandidateSims(stored, "c2", [0.8]);
  assert.deepEqual([...stored.entries()], [["c1", 0.4]]);
});
