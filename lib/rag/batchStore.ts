// DB layer for BATCH API savings (migration 0029, Phase E1).
//
// Two concerns, both raw SQL via the shared `sql` client:
//
//   1. The PER-CONFIG preference on configs.batch_savings (get / patch-merge),
//      read-merge-write like evalSettingsStore so the UPDATE stays static.
//   2. The ACCOUNT-WIDE batch_jobs ledger (create / poll-list / patch / ack).
//      Jobs are global (a provider batch isn't config-scoped) but each carries
//      config_id + a denormalized config_label so the panel can attribute it.
//
// No provider I/O here — that's lib/batch/providers.ts. This module only reads
// and writes rows; the orchestrator threads the two together.
import { activeUserId } from "@/lib/auth/userScope";
import { fragment, sql } from "@/lib/db";
import { activeConfig, isUuid } from "@/lib/rag/activeConfig";
import {
  type BatchJob,
  type BatchProvider,
  type BatchSavings,
  type BatchStatus,
  type JobKind,
  coerceBatchSavings,
  DEFAULT_BATCH_SAVINGS,
} from "@/lib/batch/types";

// --- the per-config preference (configs.batch_savings) ---------------------

export async function getBatchSavings(configId: string): Promise<BatchSavings> {
  if (!isUuid(configId)) return DEFAULT_BATCH_SAVINGS;
  const rows = await sql<{ batch_savings: unknown }[]>`
    select batch_savings from configs
    where id = ${configId} and user_id = ${activeUserId()}
    limit 1
  `;
  return rows.length > 0 ? coerceBatchSavings(rows[0].batch_savings) : DEFAULT_BATCH_SAVINGS;
}

export async function getActiveBatchSavings(): Promise<BatchSavings> {
  return getBatchSavings(activeConfig().id);
}

// A nested partial — the Settings UI sends only what it changed. Merged over the
// current (already coerced) value, then written back whole.
export type BatchSavingsPatch = {
  jobs?: Partial<BatchSavings["jobs"]>;
  semanticCache?: Partial<BatchSavings["semanticCache"]>;
};

export async function updateBatchSavings(
  configId: string,
  patch: BatchSavingsPatch,
): Promise<BatchSavings | null> {
  if (!isUuid(configId)) return null;
  // Reading coerces, so a legacy (leg-grouped) blob is already migrated here and
  // this write-back persists the flat shape.
  const cur = await getBatchSavings(configId);
  // Drop keys the caller left undefined before spreading — undefined means
  // "untouched", and a raw spread would let it erase the current value.
  const defined = <T extends object>(o: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  const next: BatchSavings = coerceBatchSavings({
    jobs: { ...cur.jobs, ...defined(patch.jobs) },
    semanticCache: { ...cur.semanticCache, ...defined(patch.semanticCache) },
  });
  const done = await sql`
    update configs set batch_savings = ${sql.json(next)}, updated_at = now()
    where id = ${configId} and user_id = ${activeUserId()}
  `;
  return done.count > 0 ? next : null;
}

// --- batch_jobs ledger -----------------------------------------------------

type BatchJobRow = {
  id: string;
  provider: string;
  provider_batch_id: string | null;
  kind: string;
  config_id: string | null;
  config_label: string;
  status: string;
  request_count: number;
  succeeded_count: number;
  errored_count: number;
  applied_count: number;
  input: unknown;
  provider_output_file_id: string | null;
  error: string | null;
  acknowledged: boolean;
  email_sent: boolean;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  applied_at: Date | null;
};

const JOB_COLUMNS = fragment`
  id, provider, provider_batch_id, kind, config_id, config_label, status,
  request_count, succeeded_count, errored_count, applied_count, input,
  provider_output_file_id, error, acknowledged, email_sent,
  created_at, updated_at, completed_at, applied_at
`;

function toJob(r: BatchJobRow): BatchJob {
  return {
    id: r.id,
    provider: r.provider as BatchProvider,
    providerBatchId: r.provider_batch_id,
    kind: r.kind as JobKind,
    configId: r.config_id,
    configLabel: r.config_label,
    status: r.status as BatchStatus,
    requestCount: r.request_count,
    succeededCount: r.succeeded_count,
    erroredCount: r.errored_count,
    appliedCount: r.applied_count,
    input: r.input,
    providerOutputFileId: r.provider_output_file_id,
    error: r.error,
    acknowledged: r.acknowledged,
    emailSent: r.email_sent,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    appliedAt: r.applied_at ? r.applied_at.toISOString() : null,
  };
}

export type NewBatchJob = {
  provider: BatchProvider;
  kind: JobKind;
  configId: string | null;
  configLabel: string;
  input: unknown;
  requestCount: number;
};

// Insert a row in the transient `submitting` state. The caller submits to the
// provider next and patches in the provider_batch_id (or marks it failed).
export async function createBatchJob(args: NewBatchJob): Promise<BatchJob> {
  const rows = await sql<BatchJobRow[]>`
    insert into batch_jobs
      (user_id, provider, kind, config_id, config_label, input, request_count, status)
    values
      (${activeUserId()}, ${args.provider}, ${args.kind}, ${args.configId},
       ${args.configLabel},
       ${sql.json(args.input as Parameters<typeof sql.json>[0])}, ${args.requestCount},
       'submitting')
    returning ${JOB_COLUMNS}
  `;
  return toJob(rows[0]);
}

export async function getBatchJob(id: string): Promise<BatchJob | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<BatchJobRow[]>`
    select ${JOB_COLUMNS} from batch_jobs
    where id = ${id} and user_id = ${activeUserId()}
    limit 1
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

// Scalar-column patch (camelCase → snake_case). jsonb `input` is set only at
// creation, so it's intentionally not patchable here. Always bumps updated_at.
export type BatchJobPatch = {
  providerBatchId?: string | null;
  status?: BatchStatus;
  requestCount?: number;
  succeededCount?: number;
  erroredCount?: number;
  appliedCount?: number;
  providerOutputFileId?: string | null;
  error?: string | null;
  acknowledged?: boolean;
  emailSent?: boolean;
  completedAt?: Date | null;
  appliedAt?: Date | null;
};

const PATCH_COLUMN: Record<keyof BatchJobPatch, string> = {
  providerBatchId: "provider_batch_id",
  status: "status",
  requestCount: "request_count",
  succeededCount: "succeeded_count",
  erroredCount: "errored_count",
  appliedCount: "applied_count",
  providerOutputFileId: "provider_output_file_id",
  error: "error",
  acknowledged: "acknowledged",
  emailSent: "email_sent",
  completedAt: "completed_at",
  appliedAt: "applied_at",
};

export async function updateBatchJob(
  id: string,
  patch: BatchJobPatch,
): Promise<BatchJob | null> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    row[PATCH_COLUMN[k as keyof BatchJobPatch]] = v;
  }
  if (Object.keys(row).length === 0) return getBatchJob(id);
  const rows = await sql<BatchJobRow[]>`
    update batch_jobs set ${sql(row)}, updated_at = now()
    where id = ${id} and user_id = ${activeUserId()}
    returning ${JOB_COLUMNS}
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

// How long a row may sit in `submitting` before the sweep below calls it dead.
// The state is meant to last one provider create() call — seconds, or tens of
// seconds for an OpenAI file upload. Anything past this is not slow, it is a
// submit whose process went away.
const STALE_SUBMIT_MINUTES = 15;

// Fail rows stranded in `submitting`, and return how many.
//
// THE STATE HAS NO OTHER EXIT. submitBatch writes the row, submits, then patches
// it to in_progress; a submit that THROWS is caught and marked failed. But a
// process that dies mid-submit (deploy, crash, platform timeout) marks nothing,
// and `submitting` is excluded from both listActiveJobs and isPollable — so the
// row is never looked at again, never terminal, and sits in the panel forever
// with no action that does anything. This is the sweep the comment on
// listActiveJobs has always promised.
//
// `provider_batch_id is null` is the safety rail, not decoration: a row that
// somehow holds a provider id is a REAL batch we are being charged for, and
// failing it locally would orphan it. Those are left alone deliberately.
//
// The honest gap, stated in the error text because we cannot resolve it here:
// if the crash landed between the provider's create() returning and our patch,
// the batch IS running on the provider under an id we never stored. Nothing
// local can recover that id, so the user is told to check the provider console
// rather than being quietly told the work never happened.
//
// Sweeping a submit that was merely very slow is self-healing rather than
// destructive: when it does return, submitBatch's patch writes the real
// provider_batch_id and status in_progress straight over the failed row.
export async function failStaleSubmittingJobs(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update batch_jobs
       set status = 'failed',
           error = 'Submit never completed — the process handling it went away. '
                || 'If it had already reached the provider, the batch may still '
                || 'be running there under an id we never recorded; check the '
                || 'provider console before resubmitting.',
           updated_at = now()
     where user_id = ${activeUserId()}
       and status = 'submitting'
       and provider_batch_id is null
       and created_at < now() - ${`${STALE_SUBMIT_MINUTES} minutes`}::interval
    returning id
  `;
  return rows.length;
}

const TERMINAL = fragment`('applied', 'failed', 'cancelled', 'expired')`;

// Newest-first, for the signed-in user — backs the status panel. "Account-wide"
// now means one user's jobs across their configs, not the whole table. Terminal
// rows stay for history; the panel can dim them.
export async function listBatchJobs(limit = 100): Promise<BatchJob[]> {
  const rows = await sql<BatchJobRow[]>`
    select ${JOB_COLUMNS} from batch_jobs
    where user_id = ${activeUserId()}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map(toJob);
}

// Jobs the orchestrator still has work to do on: provider-side unfinished
// (in_progress / cancelling) or finished-but-unapplied (completed). Excludes the
// transient `submitting` — there is nothing to poll a provider for until we hold
// a provider_batch_id — and the terminals. A submit that crashed before it got
// one is swept by failStaleSubmittingJobs above, which pollAndApply runs first.
export async function listActiveJobs(): Promise<BatchJob[]> {
  const rows = await sql<BatchJobRow[]>`
    select ${JOB_COLUMNS} from batch_jobs
    where status in ('in_progress', 'completed', 'cancelling')
      and user_id = ${activeUserId()}
    order by created_at asc
  `;
  return rows.map(toJob);
}

// Non-terminal jobs for one config — backs the "a batch is in flight; this
// change may be overwritten when it completes" warning. Optionally filtered to
// specific kinds (e.g. only ingest_embedding before a re-embed).
export async function inFlightForConfig(
  configId: string,
  kinds?: JobKind[],
): Promise<BatchJob[]> {
  if (!isUuid(configId)) return [];
  const rows = kinds && kinds.length > 0
    ? await sql<BatchJobRow[]>`
        select ${JOB_COLUMNS} from batch_jobs
        where config_id = ${configId} and status not in ${TERMINAL}
          and user_id = ${activeUserId()}
          and kind in ${sql(kinds)}
        order by created_at desc
      `
    : await sql<BatchJobRow[]>`
        select ${JOB_COLUMNS} from batch_jobs
        where config_id = ${configId} and status not in ${TERMINAL}
          and user_id = ${activeUserId()}
        order by created_at desc
      `;
  return rows.map(toJob);
}

export async function acknowledgeJob(id: string): Promise<BatchJob | null> {
  return updateBatchJob(id, { acknowledged: true });
}

// Ack every finished-but-undismissed job for the signed-in user — "I opened the
// panel, so I've seen them". Server-side rather than a client-only "seen" flag
// so the badge doesn't come back on the next reload. Returns the ids it changed,
// which is what the panel folds into its local rows.
export async function acknowledgeAllTerminal(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    update batch_jobs set acknowledged = true, updated_at = now()
    where user_id = ${activeUserId()}
      and status in ${TERMINAL}
      and acknowledged = false
    returning id
  `;
  return rows.map((r) => r.id);
}
