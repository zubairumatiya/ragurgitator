// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
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
    select batch_savings from configs where id = ${configId} limit 1
  `;
  return rows.length > 0 ? coerceBatchSavings(rows[0].batch_savings) : DEFAULT_BATCH_SAVINGS;
}

export async function getActiveBatchSavings(): Promise<BatchSavings> {
  return getBatchSavings(activeConfig().id);
}

// A nested partial — the Settings UI sends only what it changed. Merged over the
// current (already coerced) value, then written back whole.
export type BatchSavingsPatch = {
  mode?: BatchSavings["mode"];
  bulk?: Partial<BatchSavings["bulk"]>;
  jobs?: Partial<BatchSavings["jobs"]>;
  semanticCache?: Partial<BatchSavings["semanticCache"]>;
};

export async function updateBatchSavings(
  configId: string,
  patch: BatchSavingsPatch,
): Promise<BatchSavings | null> {
  if (!isUuid(configId)) return null;
  const cur = await getBatchSavings(configId);
  const next: BatchSavings = coerceBatchSavings({
    mode: patch.mode ?? cur.mode,
    bulk: { ...cur.bulk, ...patch.bulk },
    jobs: { ...cur.jobs, ...patch.jobs },
    semanticCache: { ...cur.semanticCache, ...patch.semanticCache },
  });
  const done = await sql`
    update configs set batch_savings = ${sql.json(next)}, updated_at = now()
    where id = ${configId}
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

const JOB_COLUMNS = sql`
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
      (provider, kind, config_id, config_label, input, request_count, status)
    values
      (${args.provider}, ${args.kind}, ${args.configId}, ${args.configLabel},
       ${sql.json(args.input as Parameters<typeof sql.json>[0])}, ${args.requestCount},
       'submitting')
    returning ${JOB_COLUMNS}
  `;
  return toJob(rows[0]);
}

export async function getBatchJob(id: string): Promise<BatchJob | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<BatchJobRow[]>`
    select ${JOB_COLUMNS} from batch_jobs where id = ${id} limit 1
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
    where id = ${id}
    returning ${JOB_COLUMNS}
  `;
  return rows.length > 0 ? toJob(rows[0]) : null;
}

const TERMINAL = sql`('applied', 'failed', 'canceled', 'expired')`;

// Newest-first, account-wide — backs the status panel. Terminal rows stay for
// history; the panel can dim them.
export async function listBatchJobs(limit = 100): Promise<BatchJob[]> {
  const rows = await sql<BatchJobRow[]>`
    select ${JOB_COLUMNS} from batch_jobs
    order by created_at desc
    limit ${limit}
  `;
  return rows.map(toJob);
}

// Jobs the orchestrator still has work to do on: provider-side unfinished
// (in_progress / canceling) or finished-but-unapplied (completed). Excludes the
// transient `submitting` (a crashed submit is swept separately) and terminals.
export async function listActiveJobs(): Promise<BatchJob[]> {
  const rows = await sql<BatchJobRow[]>`
    select ${JOB_COLUMNS} from batch_jobs
    where status in ('in_progress', 'completed', 'canceling')
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
          and kind in ${sql(kinds)}
        order by created_at desc
      `
    : await sql<BatchJobRow[]>`
        select ${JOB_COLUMNS} from batch_jobs
        where config_id = ${configId} and status not in ${TERMINAL}
        order by created_at desc
      `;
  return rows.map(toJob);
}

export async function acknowledgeJob(id: string): Promise<BatchJob | null> {
  return updateBatchJob(id, { acknowledged: true });
}
