// DB layer for background_jobs (0062). Raw SQL, same shape as lib/rag/batchStore.ts.
//
// Everything here runs inside a user scope and filters on activeUserId() — with
// ONE deliberate exception, resolveJobOwner, which is the only way the sessionless
// tick endpoint can find out whose scope to enter. It is documented at the call.
//
// THE LEASE PROTOCOL, because it is spread over three functions and only makes
// sense as a whole:
//
//   claimJob      — conditional UPDATE; returns a token, or null if someone else
//                   holds a live lease. Whoever gets the token owns the slice.
//   checkpointJob — carries the token. Returns false when the row no longer
//                   matches it, which means the lease was taken over (this slice
//                   ran past its window). A false is an ORDER TO STOP, not a
//                   retryable error: the other holder is now the one spending.
//   finishJob     — also token-guarded, for the same reason.
//
// Progress counters are ABSOLUTE, never incremental (`done_units = ${n}`, not
// `done_units + ${n}`). A resumed slice reports cumulative work, so an increment
// would double-count everything before the checkpoint it resumed from.
import { activeUserId } from "@/lib/auth/userScope";
import { fragment, privilegedSql, sql, toJsonb } from "@/lib/db";
import { isUuid } from "@/lib/rag/activeConfig";
import {
  type BackgroundJob,
  type JobKind,
  type JobStatus,
  isTerminal,
} from "@/lib/jobs/types";

type JobRow = {
  id: string;
  config_id: string;
  config_label: string;
  kind: string;
  status: string;
  scope: unknown;
  cursor: unknown;
  result: unknown;
  total_units: number;
  done_units: number;
  last_message: string | null;
  lease_expires_at: Date | null;
  attempts: number;
  error: string | null;
  acknowledged: boolean;
  email_sent: boolean;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const JOB_COLUMNS = fragment`
  id, config_id, config_label, kind, status, scope, cursor, result,
  total_units, done_units, last_message, lease_expires_at, attempts, error,
  acknowledged, email_sent, created_at, updated_at, started_at, finished_at
`;

const ADVANCEABLE = fragment`('queued', 'running', 'cancelling')`;
const TERMINAL = fragment`('cancelled', 'succeeded', 'failed')`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toJob(r: JobRow): BackgroundJob {
  return {
    id: r.id,
    configId: r.config_id,
    configLabel: r.config_label,
    kind: r.kind as JobKind,
    status: r.status as JobStatus,
    scope: r.scope,
    cursor: r.cursor,
    result: r.result,
    totalUnits: r.total_units,
    doneUnits: r.done_units,
    lastMessage: r.last_message,
    leaseExpiresAt: iso(r.lease_expires_at),
    attempts: r.attempts,
    error: r.error,
    acknowledged: r.acknowledged,
    emailSent: r.email_sent,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

// --- create / read ----------------------------------------------------------

export type NewJob = {
  kind: JobKind;
  configId: string;
  configLabel: string;
  scope: unknown;
  totalUnits: number;
};

export async function createJob(args: NewJob): Promise<BackgroundJob> {
  const rows = await sql<JobRow[]>`
    insert into background_jobs
      (user_id, kind, config_id, config_label, scope, total_units, status)
    values
      (${activeUserId()}, ${args.kind}, ${args.configId}, ${args.configLabel},
       ${toJsonb(args.scope)}, ${args.totalUnits}, 'queued')
    returning ${JOB_COLUMNS}
  `;
  return toJob(rows[0]);
}

export async function getJob(id: string): Promise<BackgroundJob | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<JobRow[]>`
    select ${JOB_COLUMNS} from background_jobs
    where id = ${id} and user_id = ${activeUserId()}
    limit 1
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

// Newest-first for the panel. Terminal rows stay as history.
export async function listJobs(limit = 50): Promise<BackgroundJob[]> {
  const rows = await sql<JobRow[]>`
    select ${JOB_COLUMNS} from background_jobs
    where user_id = ${activeUserId()}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map(toJob);
}

// The janitor's question: which of my jobs should be advancing but has no live
// lease? Answered oldest-first so a backlog drains in launch order.
export async function listStalledJobs(): Promise<BackgroundJob[]> {
  const rows = await sql<JobRow[]>`
    select ${JOB_COLUMNS} from background_jobs
    where user_id = ${activeUserId()}
      and status in ${ADVANCEABLE}
      and (lease_expires_at is null or lease_expires_at < now())
    order by created_at asc
  `;
  return rows.map(toJob);
}

// Backs the "a background job is already running on this config" guard, so two
// overlapping re-scores of the same corpus can't be launched by accident.
export async function activeJobsForConfig(
  configId: string,
  kinds?: JobKind[],
): Promise<BackgroundJob[]> {
  if (!isUuid(configId)) return [];
  const rows = kinds && kinds.length > 0
    ? await sql<JobRow[]>`
        select ${JOB_COLUMNS} from background_jobs
        where config_id = ${configId} and user_id = ${activeUserId()}
          and status in ${ADVANCEABLE} and kind in ${sql(kinds)}
        order by created_at desc
      `
    : await sql<JobRow[]>`
        select ${JOB_COLUMNS} from background_jobs
        where config_id = ${configId} and user_id = ${activeUserId()}
          and status in ${ADVANCEABLE}
        order by created_at desc
      `;
  return rows.map(toJob);
}

// --- the lease --------------------------------------------------------------

export type ClaimedJob = { job: BackgroundJob; leaseToken: string };

// Take the lease on a job, or return null because someone else holds it.
//
// One conditional UPDATE, so the check and the take cannot be split by a
// concurrent claimer — this is the entire concurrency control for work that
// spends money. `lease_expires_at < now()` is what makes a crashed slice
// recoverable: a holder that never released is simply outlived.
//
// A 'queued' job becomes 'running' here rather than at create time, so a job that
// was launched but whose first tick never landed is distinguishable from one that
// has actually started.
export async function claimJob(id: string, leaseSeconds: number): Promise<ClaimedJob | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<(JobRow & { lease_token: string })[]>`
    update background_jobs
       set lease_token = gen_random_uuid(),
           lease_expires_at = now() + ${`${leaseSeconds} seconds`}::interval,
           status = case when status = 'queued' then 'running' else status end,
           started_at = coalesce(started_at, now()),
           attempts = attempts + 1,
           updated_at = now()
     where id = ${id} and user_id = ${activeUserId()}
       and status in ${ADVANCEABLE}
       and (lease_expires_at is null or lease_expires_at < now())
    returning ${JOB_COLUMNS}, lease_token
  `;
  if (rows.length === 0) return null;
  return { job: toJob(rows[0]), leaseToken: rows[0].lease_token };
}

export type Checkpoint = {
  cursor?: unknown;
  doneUnits?: number;
  totalUnits?: number;
  lastMessage?: string | null;
  // Push the lease out by this many seconds. A slice that is still working should
  // keep its lease alive; one that is handing over should not.
  extendLeaseSeconds?: number;
};

// Save progress, still holding the lease. False means the lease is GONE — stop
// working immediately (see the protocol note at the top).
export async function checkpointJob(
  id: string,
  leaseToken: string,
  patch: Checkpoint,
): Promise<boolean> {
  const row: Record<string, unknown> = { updated_at: sql`now()` };
  if (patch.cursor !== undefined) {
    row.cursor = toJsonb(patch.cursor);
    // A committed cursor IS progress, which is what makes the failure count
    // consecutive rather than cumulative (0064).
    row.failures = 0;
  }
  if (patch.doneUnits !== undefined) row.done_units = patch.doneUnits;
  if (patch.totalUnits !== undefined) row.total_units = patch.totalUnits;
  if (patch.lastMessage !== undefined) row.last_message = patch.lastMessage;
  if (patch.extendLeaseSeconds !== undefined) {
    row.lease_expires_at = sql`now() + ${`${patch.extendLeaseSeconds} seconds`}::interval`;
  }
  const done = await sql`
    update background_jobs set ${sql(row)}
    where id = ${id} and user_id = ${activeUserId()} and lease_token = ${leaseToken}
  `;
  return done.count > 0;
}

// Hand the job back without finishing it: the slice hit its deadline and the next
// one should be free to claim immediately rather than wait out the lease.
export async function releaseLease(id: string, leaseToken: string): Promise<void> {
  await sql`
    update background_jobs
       set lease_token = null, lease_expires_at = null, updated_at = now()
     where id = ${id} and user_id = ${activeUserId()} and lease_token = ${leaseToken}
  `;
}

// --- terminal transitions ---------------------------------------------------

export type Finish = {
  status: Extract<JobStatus, "succeeded" | "failed" | "cancelled">;
  result?: unknown;
  error?: string | null;
  doneUnits?: number;
  lastMessage?: string | null;
};

// Token-guarded like checkpointJob: a slice that lost its lease must not be the
// one to declare the job over.
export async function finishJob(
  id: string,
  leaseToken: string,
  finish: Finish,
): Promise<BackgroundJob | null> {
  const row: Record<string, unknown> = {
    status: finish.status,
    lease_token: null,
    lease_expires_at: null,
    finished_at: sql`now()`,
    updated_at: sql`now()`,
  };
  if (finish.result !== undefined) row.result = toJsonb(finish.result);
  if (finish.error !== undefined) row.error = finish.error;
  if (finish.doneUnits !== undefined) row.done_units = finish.doneUnits;
  if (finish.lastMessage !== undefined) row.last_message = finish.lastMessage;
  const rows = await sql<JobRow[]>`
    update background_jobs set ${sql(row)}
    where id = ${id} and user_id = ${activeUserId()} and lease_token = ${leaseToken}
    returning ${JOB_COLUMNS}
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

// The durable cancel. Writes the FLAG only — the running slice notices at its next
// checkpoint and writes the terminal 'cancelled' itself, so partial work commits.
// A job nobody is running (queued, or stalled between slices) has no slice to
// notice, so it goes straight to terminal.
export async function requestCancel(id: string): Promise<BackgroundJob | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<JobRow[]>`
    update background_jobs
       set status = case
             when lease_expires_at is not null and lease_expires_at > now() then 'cancelling'
             else 'cancelled'
           end,
           finished_at = case
             when lease_expires_at is not null and lease_expires_at > now() then null
             else now()
           end,
           updated_at = now()
     where id = ${id} and user_id = ${activeUserId()}
       and status in ('queued', 'running')
    returning ${JOB_COLUMNS}
  `;
  return rows.length > 0 ? toJob(rows[0]) : getJob(id);
}

// Cheap enough to poll between units of work — one indexed primary-key read of
// one column. The runner still caches it briefly; see lib/jobs/runner.ts.
export async function isCancelRequested(id: string): Promise<boolean> {
  const rows = await sql<{ status: string }[]>`
    select status from background_jobs
    where id = ${id} and user_id = ${activeUserId()}
    limit 1
  `;
  if (rows.length === 0) return true; // the row is gone; there is nothing to finish
  return rows[0].status === "cancelling" || isTerminal(rows[0].status as JobStatus);
}

// Record that a slice THREW, and report how many have thrown in a row. The caller
// decides from that count whether to retry the slice or bury the job (0064).
//
// The lease is dropped here rather than left to expire: the next slice should be
// able to start immediately, since the work it will redo is work that rolled back.
export async function recordSliceFailure(id: string, message: string): Promise<number> {
  const rows = await sql<{ failures: number }[]>`
    update background_jobs
       set failures = failures + 1, error = ${message},
           lease_token = null, lease_expires_at = null, updated_at = now()
     where id = ${id} and user_id = ${activeUserId()} and status in ${ADVANCEABLE}
    returning failures
  `;
  return rows.length > 0 ? rows[0].failures : 0;
}

// A job whose slice died holding an un-releasable failure (an exception, not a
// cancel). Separate from finishJob because the caller may have LOST the lease —
// this is the janitor's power to bury a job, so it is not token-guarded.
export async function failJob(id: string, message: string): Promise<BackgroundJob | null> {
  const rows = await sql<JobRow[]>`
    update background_jobs
       set status = 'failed', error = ${message},
           lease_token = null, lease_expires_at = null,
           finished_at = now(), updated_at = now()
     where id = ${id} and user_id = ${activeUserId()} and status in ${ADVANCEABLE}
    returning ${JOB_COLUMNS}
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

// --- notification bookkeeping ----------------------------------------------

export async function markEmailSent(id: string): Promise<void> {
  await sql`
    update background_jobs set email_sent = true, updated_at = now()
    where id = ${id} and user_id = ${activeUserId()}
  `;
}

export async function acknowledgeJob(id: string): Promise<BackgroundJob | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<JobRow[]>`
    update background_jobs set acknowledged = true, updated_at = now()
    where id = ${id} and user_id = ${activeUserId()}
    returning ${JOB_COLUMNS}
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

// "I opened the panel, so I've seen them" — mirrors batchStore.acknowledgeAllTerminal.
export async function acknowledgeAllTerminal(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    update background_jobs set acknowledged = true, updated_at = now()
    where user_id = ${activeUserId()} and status in ${TERMINAL} and acknowledged = false
    returning id
  `;
  return rows.map((r) => r.id);
}

// --- the one privileged read ------------------------------------------------

export type JobOwner = { userId: string; email: string; jobId: string };

// Who owns this job? THE ONLY QUERY IN THE APP THAT READS background_jobs WITHOUT
// A USER SCOPE, and the fourth caller of privilegedSql that lib/db.ts warns about.
//
// It exists because of a chicken-and-egg the slicing design creates: POST
// /api/jobs/tick carries no cookie (it is fired by a dying function or a cron, not
// a browser), and withUser() needs an identity BEFORE any RLS-scoped read can
// happen. So the owner has to be resolved out of band, from the job id alone.
//
// What keeps that safe is the narrowness: it returns an id and an email for one
// job and nothing else, the caller immediately enters that user's scope, and every
// subsequent query goes through the ordinary RLS-checked `sql`. The tick endpoint
// is separately gated by an HMAC over the job id (lib/http/jobSecret.ts), so an
// unauthenticated caller cannot even reach this with a guessed uuid.
export async function resolveJobOwner(jobId: string): Promise<JobOwner | null> {
  if (!isUuid(jobId)) return null;
  const rows = await privilegedSql<{ user_id: string; email: string }[]>`
    select j.user_id, p.email
      from background_jobs j
      join user_profiles p on p.id = j.user_id
     where j.id = ${jobId}
     limit 1
  `;
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, email: rows[0].email, jobId };
}

// Every job that some slice should pick up, across ALL users — the cron backstop's
// view, which by definition has no session to scope to. Privileged for the same
// reason resolveJobOwner is, and returns ids only: the tick it triggers re-enters
// each job's own user scope before touching anything else.
export async function listStalledJobIdsAcrossUsers(limit = 20): Promise<string[]> {
  const rows = await privilegedSql<{ id: string }[]>`
    select id from background_jobs
    where status in ('queued', 'running', 'cancelling')
      and (lease_expires_at is null or lease_expires_at < now())
    order by created_at asc
    limit ${limit}
  `;
  return rows.map((r) => r.id);
}
