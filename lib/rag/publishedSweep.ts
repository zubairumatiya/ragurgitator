// THE PUBLISHED CACHE-KEY SWEEP (0077) — phase 1 of docs/demo-cache-lab-plan.md.
//
// Appraise → Semantic caching's §4 is the app's most distinctive measurement and
// the one panel a guest cannot touch at all: the leaderboard, the pair counts and
// the precision slider all render inside `{sweep && …}`, and `sweep` is client
// state set by a POST behind assertDemoAllows("sweep").
//
// Only ONE of those three actually costs anything. The slider re-derives every
// row from the curves the sweep already shipped, with selectFromCurve bundled
// client-side precisely so dragging is free. So the demo does not need to let a
// guest run a sweep; it needs to hand them a SweepResult.
//
// WHY THIS NEEDS A TABLE WHEN replay_metrics DID NOT. The replay is a cache: the
// master computes it, the row sits there, and clone step 5c copies it. The sweep
// is computed on demand and returned to the response — runKeyModelSweep stores
// nothing, and the result dies with the request. So the publish has to put it
// somewhere first, which is what 0077 is.
//
// THE SENTINEL, for the same reason step 5c uses one: a fingerprint over the
// inputs is a key nobody in the destination account will ever recompute, so a
// copied one leaves rows present but unreachable.
//
// READ-ONLY FOR THE APP. Nothing in a request path writes here — the only writer
// is scripts/demo-snapshot, at publish time, in the master's own scope. That is
// what makes this row a build artifact rather than a cache, and it is why there
// is no eviction rule to exempt it from (compare replayStore's writeCached,
// which needed one).
import "server-only";

import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { sliderTargets, thinCurve } from "@/lib/rag/calibrationCurve";
import type { SweepResult } from "@/lib/rag/keyModelSweep";
import { packSweep, type PublishedSweep } from "@/lib/rag/publishedSweepCore";

// See the module header, and 0077's column comment.
export const PUBLISHED_SWEEP_FINGERPRINT = "published";

// What the payload may weigh before it stops being something to hand out on page
// load. Not enforced — a build that exceeds it is still valid, and refusing to
// publish over a soft size limit would be worse than shipping a fat one — but
// scripts/demo-snapshot reports against it, because the alternative to noticing
// here is noticing on a visitor's connection.
export const PUBLISHED_SWEEP_MAX_BYTES = 150_000;

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

export const sweepBytes = (result: SweepResult | PublishedSweep): number =>
  Buffer.byteLength(JSON.stringify(result), "utf8");

// THE PUBLISHED FORM, whole: thinned to the slider's grid, then packed. One
// function so the size scripts/demo-snapshot reports is the size that is stored
// — the two used to be the same call and a reported number that is not the
// stored one is worse than no number.
export const publishedForm = (result: SweepResult): PublishedSweep =>
  packSweep(thinSweep(result));

// THIN THE CURVES, LOSSLESSLY — see thinCurve for the argument, and
// calibrationCurve.test.ts for the assertion that it holds at all 101 slider
// positions.
//
// Measured on the master's own set: a CalibrationResult carries one curve point
// per judged pair (~88 bytes each), so eleven models over a ~510-pair pooled set
// is ~5,600 points and ~500 KB. Thinned it is ~1,100 points, because the panel
// can only ever ask 101 questions of each curve.
//
// The result's OWN target rides along in the target list. It is normally on the
// slider's grid, but it is a stored per-config setting and nothing constrains it
// to a half-percent step — and it is the position the panel opens on, so a curve
// that could not answer it would be thinned for every target except the one that
// gets rendered first.
export function thinSweep(result: SweepResult): SweepResult {
  const targets = [...sliderTargets(), result.target];
  return {
    ...result,
    rows: result.rows.map((row) =>
      row.calibration === null
        ? row
        : {
            ...row,
            calibration: {
              ...row.calibration,
              curve: thinCurve(row.calibration.curve, targets, result.minSamples),
            },
          },
    ),
  };
}

// WRITE — publish time only, from the master's scope. `on conflict do update` so
// re-publishing replaces the build rather than failing on the second run, which
// is the same replace-not-append rule the snapshot script holds everywhere else.
export async function writePublishedSweep(
  configId: string,
  result: SweepResult,
): Promise<void> {
  await sql`
    insert into published_sweep (config_id, fingerprint, result)
    values (${configId}, ${PUBLISHED_SWEEP_FINGERPRINT}, ${sql.json(publishedForm(result) as unknown as Parameters<typeof sql.json>[0])})
    on conflict (config_id, fingerprint)
      do update set result = excluded.result, computed_at = now()
  `;
  // The publish script is its own process, so this drops nothing that is
  // actually held — it is here so that the memo below never has to be reasoned
  // about separately from the only write there is.
  forgetPublishedSweep();
}

// --- the read, and the memo in front of it ----------------------------------

// PER-PROCESS, PER-USER MEMO — phase 1.5 of docs/demo-cache-lab-plan.md.
//
// The row is re-read on every panel mount, and Supabase bills the Postgres →
// app-server hop uncompressed. It is safe to memo for the reason the module
// header already states: `published_sweep` has NO writer in any request path
// (scripts/demo-snapshot is the only one), so within a guest's ~2-hour life the
// row is immutable and a second read can only return what the first one did.
//
// NEGATIVE RESULTS ARE NOT CACHED, and that is the one asymmetry worth stating.
// The clone writes the guest's row DURING provisioning, in this same process —
// so "no sweep yet" is a state that legitimately changes, while "here is the
// sweep" is not. Caching the miss would be the one way this memo could serve a
// guest a permanently dark §4.
//
// Keyed by user rather than by build, deliberately. Every guest's row is a
// byte-for-byte copy of the same publish, so one entry could in principle serve
// all of them — but "identical by construction" is exactly the kind of
// assumption that rots quietly, and the per-user form already removes the repeat
// reads.
const memo = new Map<string, PublishedSweep>();

// Enough for every guest a process sees before it is recycled, with eviction
// only as a backstop against a long-lived one — oldest first, since a guest that
// has not been seen in that many users is gone.
const MEMO_MAX = 200;

// Exported for the tests and for anything that ever gains a writer: a memo whose
// only invalidation story is "there is no writer" needs the door to exist the
// day that stops being true.
export function forgetPublishedSweep(userId?: string): void {
  if (userId === undefined) memo.clear();
  else memo.delete(userId);
}

// READ — the build's sweep for the scoped account, or null, in its PACKED form.
// Callers hand it to the client as-is and the panel unpacks; unpacking here
// would put the 50 KB back on the wire that packing took off it.
//
// NOT config-scoped, deliberately, and the join is ownership rather than
// selection: the sweep pools every config's pairs into one set (a pair is a
// property of two question texts), so it describes the account and not the tab
// it happens to hang off. A guest workspace holds exactly one config, so the
// distinction only shows up if a publish ever carries more than one — and then
// the newest row is the right answer, since both were the same sweep.
export async function readPublishedSweep(): Promise<PublishedSweep | null> {
  const userId = activeUserId();
  const memoed = memo.get(userId);
  if (memoed) return memoed;
  try {
    const [row] = await sql<{ result: PublishedSweep }[]>`
      select s.result
        from published_sweep s
        join configs c on c.id = s.config_id
       where c.user_id = ${userId}
         and s.fingerprint = ${PUBLISHED_SWEEP_FINGERPRINT}
       order by s.computed_at desc
       limit 1
    `;
    if (!row) return null;
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
    memo.set(userId, row.result);
    return row.result;
  } catch (err) {
    if (isMissingTable(err)) return null; // pre-migration: nothing was ever published
    throw err;
  }
}
