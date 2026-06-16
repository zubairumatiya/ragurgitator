// ---------------------------------------------------------------------------
// K-MEANS (pure compute, no DB) for the /clusters page.
//
// Spherical k-means over the corpus embeddings. Voyage vectors are unit-length,
// so cosine similarity is a plain dot product (see lib/rag/embeddings.ts) — we
// assign by max dot, and after each "move centroid to the mean" step we
// re-normalize the centroid back onto the unit sphere so dot = cosine keeps
// holding (otherwise the averaged centroid drifts inside the sphere). See
// lib/rag/eval.ts `cosine()` for the same unit-vector convention.
//
// One `computeCandidate` = one k-means run from one random seed. A "run" in the
// UI fires several of these (different seeds) so the user can see the spread the
// randomness produces and keep the one they like; the orchestration + DB live in
// lib/rag/clusterStore.ts.
// ---------------------------------------------------------------------------

// One k-means result. `assignments[i]` is the cluster ordinal (0..k-1) for the
// i-th input vector; `assignmentSim[i]` is that vector's cosine similarity to its
// centroid (persisted per chunk so the bucket view can sort nearest-first).
export type Candidate = {
  seed: number;
  k: number;
  centroids: number[][];
  assignments: number[];
  assignmentSim: number[];
  sizes: number[]; // members per cluster, by ordinal
  cohesion: number[]; // mean cosine sim of members to centroid, by ordinal
  avgCohesion: number; // size-weighted (= mean over all points)
  silhouette: number; // run-level, centroid approximation, in [-1, 1]
  inertia: number; // sum of squared cosine-distance to chosen centroid
  iterations: number;
};

// Small, fast, seedable PRNG so a given seed reproduces a clustering.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Project a vector back onto the unit sphere. A zero vector (degenerate, e.g. an
// empty cluster mean) is returned as-is.
function normalized(v: number[]): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// Squared cosine distance between a vector and a (unit) centroid: ‖x−c‖² = 2−2·cos
// for unit vectors. Clamped at 0 against tiny negative float drift.
function sqDist(v: number[], c: number[]): number {
  return Math.max(0, 2 - 2 * dot(v, c));
}

// The single worst-served point (lowest similarity to its nearest centroid).
// Used to reseed an emptied cluster so we always return exactly k centroids.
function worstServedPoint(vectors: number[][], centroids: number[][]): number[] {
  let worst = 0;
  let worstSim = Infinity;
  for (let i = 0; i < vectors.length; i++) {
    let best = -Infinity;
    for (const c of centroids) {
      const s = dot(vectors[i], c);
      if (s > best) best = s;
    }
    if (best < worstSim) {
      worstSim = best;
      worst = i;
    }
  }
  return vectors[worst];
}

// k-means++ seeding: first centroid uniformly at random, each subsequent one
// chosen with probability ∝ squared distance to the nearest centroid so far.
// Spreads the seeds out and sharply improves convergence over random init.
function kmeansPlusPlus(vectors: number[][], k: number, rng: () => number): number[][] {
  const n = vectors.length;
  const centroids: number[][] = [vectors[Math.floor(rng() * n)].slice()];
  const d2 = new Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    const last = centroids[centroids.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = sqDist(vectors[i], last);
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    let r = rng() * sum;
    let idx = 0;
    while (idx < n - 1) {
      r -= d2[idx];
      if (r <= 0) break;
      idx++;
    }
    centroids.push(vectors[idx].slice());
  }
  return centroids;
}

// Lloyd's algorithm: assign → move-to-mean → renormalize, until assignments
// stabilize or `maxIters`. Returns the final centroids, assignments, each point's
// similarity to its centroid, and inertia.
function lloyd(
  vectors: number[][],
  k: number,
  rng: () => number,
  maxIters: number,
): {
  centroids: number[][];
  assignments: number[];
  assignmentSim: number[];
  inertia: number;
  iterations: number;
} {
  const n = vectors.length;
  const dim = vectors[0].length;
  let centroids = kmeansPlusPlus(vectors, k, rng);
  const assignments = new Array(n).fill(-1);
  let iterations = 0;

  for (let iter = 0; iter < maxIters; iter++) {
    iterations = iter + 1;
    let changed = false;

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const s = dot(vectors[i], centroids[c]);
        if (s > bestSim) {
          bestSim = s;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      const acc = sums[c];
      const v = vectors[i];
      for (let d = 0; d < dim; d++) acc[d] += v[d];
    }

    centroids = sums.map((sum, c) =>
      counts[c] === 0 ? worstServedPoint(vectors, centroids).slice() : normalized(sum),
    );

    if (!changed) break;
  }

  // Final assignment against the last centroid move (which may have shifted a few
  // points), plus inertia and per-point similarity.
  const assignmentSim = new Array(n).fill(0);
  let inertia = 0;
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestSim = -Infinity;
    for (let c = 0; c < k; c++) {
      const s = dot(vectors[i], centroids[c]);
      if (s > bestSim) {
        bestSim = s;
        best = c;
      }
    }
    assignments[i] = best;
    assignmentSim[i] = bestSim;
    inertia += Math.max(0, 2 - 2 * bestSim);
  }

  return { centroids, assignments, assignmentSim, inertia, iterations };
}

// Per-cluster mean cohesion (cosine sim of members to their centroid) and sizes.
// avgCohesion is size-weighted, i.e. the mean similarity across all points.
function clusterStats(
  assignments: number[],
  assignmentSim: number[],
  k: number,
): { cohesion: number[]; sizes: number[]; avgCohesion: number } {
  const cohesion = new Array(k).fill(0);
  const sizes = new Array(k).fill(0);
  let totalSim = 0;
  for (let i = 0; i < assignments.length; i++) {
    const c = assignments[i];
    sizes[c]++;
    cohesion[c] += assignmentSim[i];
    totalSim += assignmentSim[i];
  }
  for (let c = 0; c < k; c++) {
    if (sizes[c] > 0) cohesion[c] /= sizes[c];
  }
  const avgCohesion = assignments.length > 0 ? totalSim / assignments.length : 0;
  return { cohesion, sizes, avgCohesion };
}

// Mean silhouette, centroid approximation: for each point, a = distance to its
// own centroid, b = distance to the nearest other centroid; (b−a)/max(a,b),
// averaged. Unlike cohesion it accounts for separation, so it peaks at a natural
// k instead of always rising — that's what makes cross-k comparison fair.
function silhouetteApprox(
  vectors: number[][],
  assignments: number[],
  centroids: number[][],
): number {
  const k = centroids.length;
  const n = vectors.length;
  if (k < 2 || n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const own = assignments[i];
    const a = Math.sqrt(sqDist(vectors[i], centroids[own]));
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own) continue;
      const d = Math.sqrt(sqDist(vectors[i], centroids[c]));
      if (d < b) b = d;
    }
    const denom = Math.max(a, b);
    if (denom > 0) sum += (b - a) / denom;
  }
  return sum / n;
}

// One k-means run from one seed, with metrics. Caller supplies the seed so the
// run is reproducible and so a batch of restarts uses distinct seeds.
export function computeCandidate(
  vectors: number[][],
  k: number,
  seed: number,
  maxIters = 50,
): Candidate {
  const rng = mulberry32(seed);
  const { centroids, assignments, assignmentSim, inertia, iterations } = lloyd(
    vectors,
    k,
    rng,
    maxIters,
  );
  const { cohesion, sizes, avgCohesion } = clusterStats(assignments, assignmentSim, k);
  const silhouette = silhouetteApprox(vectors, assignments, centroids);
  return {
    seed,
    k,
    centroids,
    assignments,
    assignmentSim,
    sizes,
    cohesion,
    avgCohesion,
    silhouette,
    inertia,
    iterations,
  };
}

// Distinct seeds for a batch of restarts, derived from a base so one click is
// reproducible as a whole. (0x9e3779b1 is the golden-ratio mixing constant.)
export function seedForRestart(baseSeed: number, restart: number): number {
  return (baseSeed + restart * 0x9e3779b1) >>> 0;
}
