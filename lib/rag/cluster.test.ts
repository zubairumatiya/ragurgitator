// Behavior-pinning tests for the spherical k-means in cluster.ts.
//
// These don't try to prove the math — they lock in the *contracts* the rest of
// the app relies on: a seed is reproducible, we always get exactly k clusters,
// obvious structure gets recovered, and the metrics stay in their valid ranges.
//
// Run with: pnpm test
// (Node's built-in test runner, with tsx resolving the extensionless import.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCandidate, seedForRestart } from "./cluster";

// --- helpers ---------------------------------------------------------------

function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v.slice() : v.map((x) => x / n);
}

// Build `count` unit vectors clustered tightly around basis axis `axis` in
// `dim` dimensions, with small deterministic noise so each group has variety
// but every point is still unambiguously closest to its own axis.
function makeGroup(axis: number, count: number, dim: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const v = new Array(dim).fill(0);
    v[axis] = 1;
    for (let j = 0; j < dim; j++) v[j] += 0.04 * Math.sin(axis * 7 + i * 3 + j);
    out.push(unit(v));
  }
  return out;
}

// Three well-separated groups along axes 0, 1, 2.
const DIM = 6;
const GROUPS = [
  makeGroup(0, 5, DIM),
  makeGroup(1, 6, DIM),
  makeGroup(2, 4, DIM),
];
const VECTORS = GROUPS.flat();
const N = VECTORS.length;

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

// --- tests -----------------------------------------------------------------

test("returns exactly k centroids/sizes/cohesion, all the right shapes", () => {
  const k = 3;
  const c = computeCandidate(VECTORS, k, 1);
  assert.equal(c.k, k);
  assert.equal(c.centroids.length, k);
  assert.equal(c.sizes.length, k);
  assert.equal(c.cohesion.length, k);
  assert.equal(c.assignments.length, N);
  assert.equal(c.assignmentSim.length, N);
  for (const cen of c.centroids) assert.equal(cen.length, DIM);
});

test("centroids are unit-length (kept on the sphere after each move)", () => {
  const c = computeCandidate(VECTORS, 3, 7);
  for (const cen of c.centroids) {
    assert.ok(
      Math.abs(norm(cen) - 1) < 1e-9,
      `centroid norm ${norm(cen)} != 1`,
    );
  }
});

test("every assignment is a valid cluster ordinal and sizes are consistent", () => {
  const k = 3;
  const c = computeCandidate(VECTORS, k, 42);
  const tally = new Array(k).fill(0);
  for (const a of c.assignments) {
    assert.ok(Number.isInteger(a) && a >= 0 && a < k, `bad assignment ${a}`);
    tally[a]++;
  }
  assert.deepEqual(c.sizes, tally);
  assert.equal(
    c.sizes.reduce((s, x) => s + x, 0),
    N,
    "sizes must sum to the number of input vectors",
  );
});

test("recovers obvious structure: each true group lands in one distinct cluster", () => {
  const c = computeCandidate(VECTORS, 3, 12345);
  // Within each true group, all points share one cluster label...
  const labelPerGroup: number[] = [];
  let offset = 0;
  for (const g of GROUPS) {
    const labels = new Set(c.assignments.slice(offset, offset + g.length));
    assert.equal(labels.size, 1, "a true group was split across clusters");
    labelPerGroup.push([...labels][0]);
    offset += g.length;
  }
  // ...and the three groups occupy three *different* clusters.
  assert.equal(
    new Set(labelPerGroup).size,
    3,
    "two true groups collapsed together",
  );
});

test("metrics stay in their documented ranges; avgCohesion == mean(assignmentSim)", () => {
  const c = computeCandidate(VECTORS, 3, 99);
  assert.ok(
    c.silhouette >= -1 && c.silhouette <= 1,
    `silhouette ${c.silhouette} out of [-1,1]`,
  );
  assert.ok(c.avgCohesion >= -1 && c.avgCohesion <= 1);
  assert.ok(c.inertia >= 0, "inertia must be non-negative");
  assert.ok(c.iterations >= 1 && c.iterations <= 50);

  const mean = c.assignmentSim.reduce((s, x) => s + x, 0) / N;
  assert.ok(
    Math.abs(c.avgCohesion - mean) < 1e-12,
    "avgCohesion should equal mean assignmentSim",
  );

  // Well-separated data -> tight clusters and clear separation.
  assert.ok(
    c.avgCohesion > 0.9,
    `expected high cohesion, got ${c.avgCohesion}`,
  );
  assert.ok(
    c.silhouette > 0.5,
    `expected clear separation, got ${c.silhouette}`,
  );
});

test("same seed reproduces an identical candidate", () => {
  const a = computeCandidate(VECTORS, 3, 2024);
  const b = computeCandidate(VECTORS, 3, 2024);
  assert.deepEqual(a.assignments, b.assignments);
  assert.deepEqual(a.centroids, b.centroids);
  assert.deepEqual(a.assignmentSim, b.assignmentSim);
  assert.equal(a.inertia, b.inertia);
  assert.equal(a.silhouette, b.silhouette);
  assert.equal(a.avgCohesion, b.avgCohesion);
  assert.equal(a.iterations, b.iterations);
});

test("k=1 is a degenerate but valid run (silhouette undefined -> 0)", () => {
  const c = computeCandidate(VECTORS, 1, 5);
  assert.equal(c.centroids.length, 1);
  assert.ok(c.assignments.every((a) => a === 0));
  assert.equal(c.sizes[0], N);
  assert.equal(
    c.silhouette,
    0,
    "silhouette needs k>=2 and is reported as 0 otherwise",
  );
});

test("over-clustering still yields exactly k finite centroids (empty clusters reseeded)", () => {
  const k = 8; // more clusters than there are natural groups
  const c = computeCandidate(VECTORS, k, 3);
  assert.equal(c.centroids.length, k);
  assert.equal(c.sizes.length, k);
  for (const cen of c.centroids) {
    assert.equal(cen.length, DIM);
    assert.ok(
      cen.every((x) => Number.isFinite(x)),
      "reseeded centroid must be finite",
    );
  }
});

test("seedForRestart is deterministic, uint32, and spreads restarts apart", () => {
  assert.equal(
    seedForRestart(100, 0),
    100 >>> 0,
    "restart 0 should be the base seed",
  );
  assert.equal(
    seedForRestart(100, 3),
    seedForRestart(100, 3),
    "must be deterministic",
  );

  const seeds = Array.from({ length: 16 }, (_, r) => seedForRestart(100, r));
  for (const s of seeds) {
    assert.ok(
      Number.isInteger(s) && s >= 0 && s < 2 ** 32,
      `seed ${s} is not uint32`,
    );
  }
  assert.equal(new Set(seeds).size, seeds.length, "restart seeds collided");
});
