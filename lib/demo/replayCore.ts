// THE REPLAY STORE'S PAYLOAD SHAPES — phase 1 of docs/demo-cache-replay-plan.md.
//
// `demo_replay.payload` (0080) is jsonb written by one process (the publish) and
// read by another (a guest's request), which is the seam where a field silently
// stops being written and nothing notices until a visitor's leaderboard is short
// a column. So the three kinds get one module that names them.
//
// SPLIT OUT OF replay.ts FOR THE REASON pairBankCore IS SPLIT OUT OF pairBank:
// this half touches no database and no request scope, so it is unit-testable on
// its own, while the half that opens a transaction is not. Nothing here imports
// "server-only" or lib/db, and it should stay that way.
import { createHash } from "node:crypto";

import { pairKey, type PairDifficultyLike, type PairLabelLike } from "@/lib/rag/keyModelSweepCore";

// The single matrix row's key. A constant rather than an empty string so the
// three kinds read alike at every call site, and so a second matrix (a second
// pooled set, if one ever exists) has somewhere to go without a migration.
export const MATRIX_KEY = "pooled";

// The single progress row's key — how far the generate slider has advanced.
export const PROGRESS_KEY = "pairs";

// STABLE IDENTITY, and it is the one thing phase 1 has to get right. The matrix
// is banked in the master's order and subsetted by "the first n", so that n must
// mean the SAME n pairs on both sides of the clone and across both publish hops
// (master → seed → guest). Position alone cannot promise that — a re-publish
// with one extra pair would shift every index — so each pair carries a hash of
// its own two texts and the order is data, not an accident of a query plan.
//
// Over `pairKey`, which is UNORDERED (lower text first): a pair is unordered
// everywhere else in the sweep — insertPairs canonicalises by hash and a shadow
// row's (new_query, matched_query) can arrive either way round — so an identity
// that distinguished the two orientations would call one pair two.
export const pairIdentity = (textA: string, textB: string): string =>
  createHash("sha256").update(pairKey(textA, textB), "utf8").digest("hex").slice(0, 32);

// A banked pair: everything about it EXCEPT its text, which is the whole point.
// The demo ships no pair rows any more, so nothing here can be turned back into
// a question a guest could read — and nothing downstream needs to, because every
// number on the page is a function of the sims and the labels.
export type ReplayPair = {
  // pairIdentity(textA, textB). Not read on the happy path — the order is — but
  // it is what lets a re-publish be diffed against the last one, and what a
  // banked shadow verdict joins to.
  hash: string;
  label: PairLabelLike;
  source: "shadow" | "generated";
  // shadow only, and load-bearing: poolPairs resolves a generated/shadow
  // collision differently for `probe` than for `traffic` (the F3 rule).
  origin?: "traffic" | "probe";
  // generated only.
  difficulty: PairDifficultyLike | null;
  // Whether F3's screen contradicted the generator's label. Carried rather than
  // dropped because the demo's screen button RESOLVES it: a guest generates
  // pairs unscreened, and screening is what admits them to the sweep.
  quarantined: boolean;
};

// THE MATRIX ITSELF. `sims` is parallel to `models` in the outer index and to
// `pairs` in the inner one — a rectangle, not a map — because that is both the
// smallest JSON encoding of it and the shape the readers want: one model's
// column, subsetted to the first n, is `sims[m].slice(0, n)`.
//
// A model that failed to score is `null` rather than a row of zeros, so an
// unreachable provider at publish time cannot masquerade as a model that scored
// every pair at no similarity.
export type ReplayMatrix = {
  version: 1;
  // The candidate list in the order the sweep ran it, so a replayed leaderboard
  // is in the master's order rather than the config's current one.
  models: string[];
  pairs: ReplayPair[];
  sims: (number[] | null)[];
  // The sweep's own inputs, banked because they are settings rather than
  // measurements and the guest's copy of them is a clone artifact: reading them
  // back from the guest's config would let a rewritten setting silently restate
  // what the master measured.
  target: number;
  minSamples: number;
};

// How far this guest has advanced, and whether they have screened. The ONLY
// mutable kind: a guest's clicks write here and nowhere else.
export type ReplayProgress = {
  // How many of the matrix's GENERATED pairs the visitor has reached. The
  // shadow half is theirs already — the clone carries the judged rows — so it is
  // never rationed.
  generated: number;
  // Generate leaves pairs unscreened; screening admits them to the sweep. False
  // means the quarantine over the current n is unresolved.
  screened: boolean;
};

// The verdict the operator's judge really returned for one queued shadow row,
// which clone step 5b blanks and today throws away. Field-for-field the five
// columns it nulls, snake_case because the payload is a row.
export type ReplayShadowVerdict = {
  verdict: string;
  judge_source?: string | null;
  judge_model?: string | null;
  judge_reason?: string | null;
  judged_at?: string | null;
};

// SIMS ARE ROUNDED ON THE WAY IN, at a precision chosen against the readers
// rather than against the disk. A cosine serialises to ~19 characters at full
// double precision, and eleven models over ~345 pairs is ~3,800 of them — 72 kB
// of digits nothing can see. Six places is ~34 kB and is still four orders of
// magnitude finer than the finest distinction any reader draws: τ is chosen on
// the curve's own grid and printed to three places, and calibrateFromJudged
// compares sims only for ordering and for `>= τ`, where a 1e-6 perturbation can
// only re-order pairs that were already indistinguishable.
export const SIM_PRECISION = 1e6;
export const roundSim = (sim: number): number => Math.round(sim * SIM_PRECISION) / SIM_PRECISION;

// What the matrix may weigh before it stops being something to hand a visitor on
// page load. Not enforced — a build that exceeds it is still valid, and refusing
// to publish over a soft limit would be worse than shipping a fat one — but
// scripts/demo-snapshot reports against it, exactly as it does for
// PUBLISHED_SWEEP_MAX_BYTES, because the alternative to noticing here is
// noticing on a visitor's connection.
export const DEMO_MATRIX_MAX_BYTES = 150_000;

export const matrixBytes = (matrix: ReplayMatrix): number =>
  Buffer.byteLength(JSON.stringify(matrix), "utf8");

// Build the banked form. ONE function so the size scripts/demo-snapshot reports
// is the size that is stored: the rounding below is what makes those two numbers
// differ, and a reported number that is not the stored one is worse than none.
//
// THROWS on a ragged rectangle rather than banking one. A `sims` row shorter
// than `pairs` is a publish bug that would surface as a leaderboard quietly
// scoring a different pair set per model, which is the single hardest thing to
// see on the finished page.
export function packMatrix(input: {
  models: string[];
  pairs: ReplayPair[];
  sims: (number[] | null)[];
  target: number;
  minSamples: number;
}): ReplayMatrix {
  if (input.sims.length !== input.models.length) {
    throw new Error(`replay matrix: ${input.sims.length} sim rows for ${input.models.length} models`);
  }
  for (const [i, row] of input.sims.entries()) {
    if (row !== null && row.length !== input.pairs.length) {
      throw new Error(
        `replay matrix: model ${input.models[i]} scored ${row.length} of ${input.pairs.length} pairs`,
      );
    }
  }
  return {
    version: 1,
    models: [...input.models],
    pairs: input.pairs,
    sims: input.sims.map((row) => (row === null ? null : row.map(roundSim))),
    target: input.target,
    minSamples: input.minSamples,
  };
}

// One model's column, or null if it never scored. Read by every replayed number
// on the page, so it is here rather than at three call sites that could each
// drift about what a missing model means.
export function simsFor(matrix: ReplayMatrix, model: string): number[] | null {
  const i = matrix.models.indexOf(model);
  return i === -1 ? null : (matrix.sims[i] ?? null);
}
