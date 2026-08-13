// THE SLICE RUNNER — what actually advances a background job.
//
// A slice is one function invocation's worth of a long job: claim the lease, work
// from the stored cursor until a soft deadline, save where we got to, and hand off
// to the next slice. Read migrations/0062_background_jobs.sql first for why the
// work is sliced at all (a Vercel function is killed at 300s on Hobby, and
// after()/waitUntil work counts against the same clock).
//
// FOUR TRANSACTIONS, NOT ONE, AND THE ORDER IS LOAD-BEARING.
//
// Since 0051 a user scope IS a database transaction (lib/db.ts), and claimJob
// UPDATEs the job row — so holding the claim inside the work scope would keep a
// ROW LOCK on that job for the entire slice, and every attempt to write live
// progress to the same row would block behind it until the slice ended. Which
// would mean a progress bar that only moves once every four minutes, i.e. no
// progress bar. So the slice is:
//
//   1. claim      (own transaction, milliseconds — takes the lease, commits)
//   2. work       (own transaction, minutes — touches eval tables, NEVER the job row)
//   3. checkpoint (own transaction — writes the cursor AFTER the work committed)
//   4. finish     (own transaction — terminal status + email)
//
// Live progress during 2 is written out of band on its own connection, which is
// only safe because of the "never the job row" rule in step 2.
//
// WORK COMMITS BEFORE THE CURSOR MOVES, deliberately. Crash between 2 and 3 and
// the next slice redoes that slice's work; crash the other way round and it would
// SKIP work that was never committed. Redoing is recoverable, skipping is silent
// data loss, so every step must be idempotent — the same requirement the batch
// handlers already carry (lib/batch/jobs/registry.ts).
//
// The consequence for progress numbers: done_units is written out of band, so a
// slice that dies mid-flight can leave it a little ahead of what actually
// committed. The CURSOR is the authority and cannot run ahead; the counter is
// cosmetic and the next slice's first checkpoint corrects it.
import { withUser, type RequestUser } from "@/lib/auth/userScope";
import { runOutsideUserTransaction } from "@/lib/db";
import { postJobTick } from "@/lib/http/jobSecret";
import { sendJobCompletionEmail } from "@/lib/jobs/notify";
import { stepFor } from "@/lib/jobs/registry";
import {
  checkpointJob,
  claimJob,
  createJob,
  failJob,
  finishJob,
  getJob,
  isCancelRequested,
  listStalledJobIdsAcrossUsers,
  recordSliceFailure,
  listStalledJobs,
  markEmailSent,
  releaseLease,
  resolveJobOwner,
  type ClaimedJob,
} from "@/lib/jobs/store";
import { recordTiming } from "@/lib/jobs/timing";
import {
  type BackgroundJob,
  type JobKind,
  type JobProgress,
  type StopSignal,
} from "@/lib/jobs/types";
import {
  resolveConfig,
  withConfig,
  activeConfig,
  type ResolvedConfig,
} from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";

// How long one slice may work before it must checkpoint and hand over. Under
// Vercel Hobby's 300s hard kill with room for the tail (finalize, the email, the
// chain request) — the deadline is soft and only checked BETWEEN units of work, so
// the margin has to cover one unit of overrun too. A single unit here is one
// question or one chunk: seconds, not minutes.
const SLICE_BUDGET_MS = Number(process.env.JOBS_SLICE_BUDGET_MS ?? 240_000);

// The lease outlives the budget, or a slice would lose its claim while still
// legitimately working and a janitor sweep would start a second one alongside it.
const LEASE_SECONDS = Math.ceil(SLICE_BUDGET_MS / 1000) + 120;

// Live progress is a courtesy, not the record. Throttled so a fast job doesn't
// spend more time reporting than working.
const PROGRESS_INTERVAL_MS = 4_000;

// Cancellation is polled between units; caching it briefly keeps a per-question
// loop from turning into a per-question round trip. The cost is that a cancel can
// take this long to be noticed, on top of the current unit — well inside what
// "cancelling…" means to a user.
const CANCEL_POLL_MS = 3_000;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Run `fn` in the owner's scope, in a FRESH transaction. runOutsideUserTransaction
// first because withUser is reentrant: without it, a call made from inside the work
// scope would silently join the long-running work transaction instead of getting
// its own — which is exactly the row-lock trap described above.
function inOwnScope<T>(owner: RequestUser, fn: () => Promise<T>): Promise<T> {
  return runOutsideUserTransaction(() => withUser(owner, fn));
}

// How many slices may throw IN A ROW before the job is buried. Consecutive: any
// slice that commits a cursor resets the count, so a long job survives the odd
// network blip while one that cannot get past the same unit stops quickly rather
// than ticking itself forever. Three is enough to ride out a provider hiccup and
// short enough that a real error is reported while the user still remembers asking.
const MAX_SLICE_FAILURES = 3;

export type SliceOutcome =
  | "unknown"      // no such job, or its owner is gone
  | "busy"         // someone else holds the lease
  | "handed-off"   // deadline hit, next slice ticked
  | "retrying"     // the slice threw; re-ticked to run again from the last cursor
  | "finished"     // terminal status written
  | "failed";

// Advance one job by one slice. The entry point for POST /api/jobs/tick, and the
// only function that should ever be doing so.
export async function runSlice(jobId: string): Promise<SliceOutcome> {
  // Sessionless by nature — see the note on resolveJobOwner. Everything after this
  // line runs inside the owner's scope and under RLS.
  const found = await resolveJobOwner(jobId);
  if (!found) return "unknown";
  const owner: RequestUser = { id: found.userId, email: found.email };

  const claimed = await inOwnScope(owner, () => claimJob(jobId, LEASE_SECONDS));
  if (!claimed) return "busy";

  try {
    return await advance(owner, claimed);
  } catch (e) {
    // The work transaction has already rolled back by the time we get here, so the
    // job is sitting on its last committed checkpoint and re-running from there is
    // safe — which is what makes a retry the right answer to a transient provider
    // error rather than ending a forty-minute job over one bad request (0064).
    const message = msg(e);
    const failures = await inOwnScope(owner, () => recordSliceFailure(jobId, message));
    if (failures > 0 && failures < MAX_SLICE_FAILURES) {
      console.warn(
        `[jobs] slice for ${jobId} failed (${failures}/${MAX_SLICE_FAILURES}), retrying: ${message}`,
      );
      await postJobTick(jobId);
      return "retrying";
    }
    console.warn(`[jobs] slice for ${jobId} failed, giving up: ${message}`);
    // failJob is not lease-guarded on purpose: this slice may have lost its lease,
    // and a job whose work threw still has to stop being "running".
    const failed = await inOwnScope(owner, () => failJob(jobId, message));
    if (failed) await notify(owner, failed);
    return "failed";
  }
}

async function advance(owner: RequestUser, claimed: ClaimedJob): Promise<SliceOutcome> {
  const { job, leaseToken } = claimed;
  const step = stepFor(job.kind);
  if (!step) {
    const failed = await inOwnScope(owner, () => failJob(job.id, `No step for kind ${job.kind}.`));
    if (failed) await notify(owner, failed);
    return "failed";
  }

  const config = await inOwnScope(owner, () => resolveConfig(job.configId));
  if (!config) {
    // The config was deleted between slices. 0062 cascades the job row away with
    // its config, so this is the narrow window where the row still exists.
    const failed = await inOwnScope(owner, () =>
      failJob(job.id, "The config this job was running on no longer exists."),
    );
    if (failed) await notify(owner, failed);
    return "failed";
  }

  const deadline = Date.now() + SLICE_BUDGET_MS;
  let cancelSeen = false;
  let cancelCheckedAt = 0;
  let lastProgressAt = 0;
  let doneUnits = job.doneUnits;
  let lastMessage: string | null = job.lastMessage;
  // Carried in from the row rather than started at zero: these accumulate over the
  // whole job, and this slice only knows about its own share (0066).
  let failedUnits = job.failedUnits;
  let lastUnitError: string | null = job.lastUnitError;
  // Sticky across slices via the row (0067): once a step says it has left the
  // phase that spends, a cancel stops ending the job.
  let mustFinish = job.mustFinish;

  // Best-effort, out of band, and never allowed to throw: a progress write that
  // fails must not cost the slice the work it is reporting on.
  const writeProgress = async () => {
    lastProgressAt = Date.now();
    try {
      await inOwnScope(owner, () =>
        checkpointJob(job.id, leaseToken, {
          doneUnits,
          failedUnits,
          lastUnitError,
          lastMessage,
          extendLeaseSeconds: LEASE_SECONDS,
        }),
      );
    } catch (e) {
      console.warn(`[jobs] progress write for ${job.id} failed: ${msg(e)}`);
    }
  };

  // Handed to the step and polled between units of work. Same contract as
  // lib/http/cancelRegistry.ts: this is a FLAG, and a step that reads it must
  // break out of its loop and return normally so partial work commits.
  // The deadline is unconditional; the cancel is not. A step in its accounting
  // tail (0067) has already spent the money and only has books to close, so
  // stopping it there would leave the corpus in the state the spend created and
  // nothing recording that it happened. It still slices on the deadline, so this
  // cannot turn into an unstoppable loop.
  const shouldStop: StopSignal = Object.assign(
    () => {
      if (Date.now() > deadline) return true;
      return cancelSeen && !mustFinish;
    },
    // The cancel is reported even while mustFinish is suppressing the boolean,
    // because the only reader is a step deciding whether more of the SAME work is
    // coming — and once it has been cancelled, none is.
    { reason: () => (cancelSeen ? "cancel" : Date.now() > deadline ? "deadline" : null) },
  );

  const emit = (progress: JobProgress) => {
    doneUnits = progress.doneUnits;
    if (progress.message !== undefined) lastMessage = progress.message;
    // The one thing in JobProgress the streaming driver does NOT also need: a
    // per-unit failure is already in `event` for a human watching the stream, and
    // nothing here is watching. Counted rather than replaced, so the job's
    // "succeeded" can't hide the units it dropped getting there.
    if (progress.failure !== undefined) {
      failedUnits += 1;
      lastUnitError = progress.failure;
    }
    // Fire-and-forget on purpose: emit() is called from inside a tight loop that
    // must not await a database round trip per unit. The throttle keeps these
    // from overlapping in practice, and each one is independently safe.
    if (Date.now() - lastProgressAt > PROGRESS_INTERVAL_MS) void writeProgress();
    // Same cadence, same reason — a cancel that arrives mid-slice is noticed here.
    if (Date.now() - cancelCheckedAt > CANCEL_POLL_MS) {
      cancelCheckedAt = Date.now();
      void inOwnScope(owner, () => isCancelRequested(job.id))
        .then((c) => {
          cancelSeen = cancelSeen || c;
        })
        .catch(() => {
          // A failed cancel poll means "no news", not "cancel": guessing yes here
          // would stop a healthy job because one query timed out.
        });
    }
  };

  // THE WORK. Its own transaction, and it must never touch the job row — see the
  // header. `scope` and `cursor` are opaque to this file; only the step knows.
  const result = await inOwnScope(owner, () =>
    withConfig(config, () =>
      step.run(job.scope as never, job.cursor as never, emit, shouldStop),
    ),
  );
  doneUnits = result.doneUnits;
  mustFinish = mustFinish || result.mustFinish === true;

  // The cursor moves only now, after the work above has committed.
  const stillOurs = await inOwnScope(owner, () =>
    checkpointJob(job.id, leaseToken, {
      cursor: result.cursor,
      doneUnits,
      failedUnits,
      lastUnitError,
      lastMessage,
      mustFinish,
      extendLeaseSeconds: LEASE_SECONDS,
    }),
  );
  if (!stillOurs) {
    // Another slice took the lease over while we worked. Ours committed its work
    // and is idempotent, so nothing is lost — but this slice has no authority to
    // finish or chain the job any more.
    return "busy";
  }

  const cancelled = await inOwnScope(owner, () => isCancelRequested(job.id));
  if (cancelled && !result.done && !mustFinish) {
    const done = await inOwnScope(owner, () =>
      finishJob(job.id, leaseToken, {
        status: "cancelled",
        doneUnits,
        lastMessage: "Cancelled — everything processed up to here was kept.",
      }),
    );
    if (done) {
      // A cancelled run still measured something real: the units it did process
      // took as long as they took, which is exactly what the estimate needs.
      await learnTiming(owner, done, config);
      await notify(owner, done);
    }
    return "finished";
  }

  if (!result.done) {
    // Hand over: release the lease first so the next slice can claim immediately
    // rather than wait out a lease nobody is using.
    await inOwnScope(owner, () => releaseLease(job.id, leaseToken));
    await postJobTick(job.id);
    return "handed-off";
  }

  // Last slice. finalize() is the once-per-job tail — the snapshot freeze and the
  // headline numbers — and it runs in the config scope like the work did.
  const summary = step.finalize
    ? await inOwnScope(owner, () =>
        withConfig(config, () => step.finalize!(job.scope as never, result.cursor as never)),
      )
    : {};
  const done = await inOwnScope(owner, () =>
    finishJob(job.id, leaseToken, {
      // A tail that ran to the end after a cancel still ends CANCELLED: it closed
      // the books on the work it did, which is not the same as having done the
      // work that was asked for.
      status: cancelled ? "cancelled" : "succeeded",
      result: summary,
      doneUnits,
      lastMessage: null,
    }),
  );
  if (done) {
    await learnTiming(owner, done, config);
    await notify(owner, done);
  }
  return "finished";
}

// Fold a finished job into the per-unit averages the ETA is built from. Needs the
// config scope, since the average is keyed by the config facts that change how
// long a unit takes (lib/jobs/timing.ts).
async function learnTiming(
  owner: RequestUser,
  job: BackgroundJob,
  config: ResolvedConfig,
): Promise<void> {
  if (!job.startedAt || !job.finishedAt) return;
  const elapsed = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
  // Wall clock across every slice, INCLUDING the gaps between them. Those gaps are
  // a handful of seconds against minutes of work, and counting them is the more
  // honest answer to "how long will this take?" — which is what the number is for.
  await inOwnScope(owner, () =>
    withConfig(config, () => recordTiming(job.kind, job.doneUnits, elapsed)),
  );
}

// One mail per job, stamped so a later sweep can't send a second.
async function notify(owner: RequestUser, job: BackgroundJob): Promise<void> {
  try {
    const sent = await sendJobCompletionEmail(job, owner.email);
    if (sent) await inOwnScope(owner, () => markEmailSent(job.id));
  } catch (e) {
    console.warn(`[jobs] completion email for ${job.id} failed: ${msg(e)}`);
  }
}

// --- launching --------------------------------------------------------------

// Create a job and kick off its first slice. Runs inside the launching request's
// user + config scope, so plan() sees exactly the corpus the user is looking at.
//
// plan() runs HERE rather than in the first slice so the panel has a denominator
// (and the user a believable ETA) the moment the job appears, instead of an empty
// bar until the first checkpoint.
export async function launchJob(kind: JobKind, scope: unknown): Promise<BackgroundJob> {
  const step = stepFor(kind);
  if (!step) throw new Error(`No step registered for job kind ${kind}.`);
  const { totalUnits, cursor } = await step.plan(scope as never);
  const cfg = activeConfig();
  const record = await getConfig(cfg.id);
  const job = await createJob({
    kind,
    configId: cfg.id,
    configLabel: record?.label ?? "—",
    scope,
    cursor,
    totalUnits,
  });
  // Not awaited for completion — postJobTick returns as soon as the tick is
  // acknowledged, and the slice runs in that other invocation.
  await postJobTick(job.id);
  return job;
}

// --- the janitor ------------------------------------------------------------

// Nudge every job of the SIGNED-IN USER that should be advancing but holds no live
// lease. This is the chain's safety net, not a scheduler: a healthy job is leased
// and therefore invisible here, and nothing below ever starts work that a user did
// not launch.
//
// Called from the panel's poll, which makes "having the app open" the primary
// recovery mechanism — the honest design for Vercel Hobby, where cron can only fire
// once a day and a broken chain would otherwise wait that long.
export async function sweepStalledJobs(): Promise<BackgroundJob[]> {
  const stalled = await listStalledJobs();
  for (const job of stalled) {
    await postJobTick(job.id);
  }
  return stalled;
}

// The cron backstop's version: every user's stalled jobs, ids only. Bounded per
// call because a sweep that tries to revive a hundred jobs in one invocation would
// be killed partway through and revive none of them reliably.
export async function sweepStalledJobsAcrossUsers(limit = 20): Promise<number> {
  const ids = await listStalledJobIdsAcrossUsers(limit);
  for (const id of ids) {
    await postJobTick(id);
  }
  return ids.length;
}

// Re-tick one job by hand — the panel's "Resume" on a job that looks stuck. Safe
// to press at any time: a job that is actually running is leased, so the tick it
// sends finds it busy and does nothing.
export async function resumeJob(id: string): Promise<BackgroundJob | null> {
  const job = await getJob(id);
  if (!job) return null;
  await postJobTick(id);
  return job;
}
