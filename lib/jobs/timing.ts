// "About twenty minutes" — where that number comes from.
//
// Estimating is a multiplication: units × milliseconds-per-unit. plan() supplies
// the units honestly (it counts the same rows the work will iterate); this module
// owns the second factor, learned from the runs that already happened (0063) and
// falling back to a seed when there is no history yet.
//
// EVERY RUN TEACHES, including the streamed ones. That is deliberate: the button
// people press today is the streaming one, so if only background jobs recorded
// timings the first estimate would always be a seed — and the seed is exactly the
// number that decides whether to offer the background at all.
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import type { JobKind } from "@/lib/jobs/types";

// First-run guesses, in milliseconds per unit, measured on the history corpus with
// cached query vectors. They only have to be the right order of magnitude: one real
// run replaces most of their weight, and being wrong here shows up as an offer that
// was not needed (or not made) rather than as a broken run.
const SEED_MS_PER_UNIT: Record<JobKind, number> = {
  rescore: 700,      // one question: cached vector + one ANN query, 4 in parallel
  bulk_ndcg: 1_500,  // one question: candidate pool + cross-model aggregate
  autotune: 20_000,  // one chunk: a search over sizes and models, with re-scores
};

// How fast the average forgets. 0.3 leans on history while still moving after a
// config change that made every unit slower — about three runs to mostly adopt a
// new speed, which matches how often these are run.
const ALPHA = 0.3;

// A sample worth learning from. A three-question re-score is dominated by fixed
// setup, so folding it in would teach the average that everything is slow.
const MIN_UNITS = 10;

// The part of the config that changes per-unit cost. Just the embedding model
// today — it decides whether a unit is a local matmul or a paid round trip, which
// is the difference that matters. Widen this (and the estimates re-learn) if
// something else turns out to dominate.
export function timingVariant(): string {
  return activeConfig().embeddingModel;
}

export type Estimate = {
  units: number;
  msPerUnit: number;
  seconds: number;
  // 'measured' once there is real history; 'seed' when this is a first run. The UI
  // uses it to choose between "about 20 minutes" and "probably around 20 minutes".
  source: "measured" | "seed";
  samples: number;
};

export async function estimate(kind: JobKind, units: number): Promise<Estimate> {
  const rows = await sql<{ ms_per_unit: number; samples: number }[]>`
    select ms_per_unit, samples from job_unit_timing
    where user_id = ${activeUserId()} and kind = ${kind} and variant = ${timingVariant()}
    limit 1
  `;
  const measured = rows.length > 0;
  const msPerUnit = measured ? rows[0].ms_per_unit : SEED_MS_PER_UNIT[kind];
  return {
    units,
    msPerUnit,
    seconds: Math.round((units * msPerUnit) / 1000),
    source: measured ? "measured" : "seed",
    samples: measured ? rows[0].samples : 0,
  };
}

// Fold one finished run into the average. Best-effort by contract: a run must never
// fail because we could not write down how long it took.
//
// Cancelled and failed runs are still worth learning from — the units they DID
// process took as long as they took — so callers pass whatever actually completed.
export async function recordTiming(
  kind: JobKind,
  units: number,
  elapsedMs: number,
): Promise<void> {
  if (units < MIN_UNITS || elapsedMs <= 0) return;
  const observed = elapsedMs / units;
  // The ::real casts are load-bearing: two bare parameters either side of a `*`
  // leave Postgres with "operator is not unique: unknown * unknown", which this
  // best-effort write swallowed silently until the table stayed suspiciously empty.
  // (And the note lives here rather than as a `--` comment inside the template —
  // postgres.js does not keep one intact, which fails as "syntax error at end of
  // input".)
  try {
    await sql`
      insert into job_unit_timing (user_id, kind, variant, ms_per_unit, samples)
      values (${activeUserId()}, ${kind}, ${timingVariant()}, ${observed}, 1)
      on conflict (user_id, kind, variant) do update
        set ms_per_unit = ${ALPHA}::real * ${observed}::real
                        + ${1 - ALPHA}::real * job_unit_timing.ms_per_unit,
            samples = job_unit_timing.samples + 1,
            updated_at = now()
    `;
  } catch (e) {
    console.warn(`[jobs:timing] could not record ${kind}: ${String(e)}`);
  }
}

// The line above which we offer to run in the background instead. Ten minutes is
// the user's number: long enough that watching a bar is a waste of a person, short
// enough that the offer arrives before they have committed to waiting.
export function backgroundThresholdSeconds(): number {
  return Number(process.env.JOBS_BACKGROUND_THRESHOLD_MIN ?? 10) * 60;
}
