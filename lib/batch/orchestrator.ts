// ---------------------------------------------------------------------------
// ORCHESTRATOR — threads store ↔ providers ↔ job handlers ↔ notify.
//
//   submitBatch  — create the row, submit to the provider, stamp the id (or fail).
//   pollAndApply — the "Check now" / poll-while-open entry: advance every active
//                  job one step (refresh status; apply on completion; notify).
//   cancelJob    — provider cancel + local status.
//
// Apply runs inside the job's config scope (resolveConfig + withConfig) since
// the handlers read activeConfig()-scoped tables, and it runs LATE — long after
// the original request. Handlers are idempotent, so the modest double-apply
// window from two overlapping polls in a single-user app is harmless.
// ---------------------------------------------------------------------------
import { withConfig, resolveConfig } from "@/lib/rag/activeConfig";
import {
  createBatchJob,
  getBatchJob,
  listActiveJobs,
  listBatchJobs,
  updateBatchJob,
} from "@/lib/rag/batchStore";
import { adapterFor, type SubmitMeta } from "@/lib/batch/providers";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { sendCompletionEmail } from "@/lib/batch/notify";
import type { BatchJob, BatchProvider, BatchRequest, JobKind } from "@/lib/batch/types";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type SubmitArgs = {
  kind: JobKind;
  provider: BatchProvider;
  configId: string | null;
  configLabel: string;
  requests: BatchRequest[];
  input: unknown;
  submitMeta: SubmitMeta;
};

// Create the ledger row FIRST (state 'submitting'), then submit — so a crash
// mid-submit leaves a visible 'submitting' row rather than a silent charge.
export async function submitBatch(args: SubmitArgs): Promise<BatchJob> {
  const job = await createBatchJob({
    provider: args.provider,
    kind: args.kind,
    configId: args.configId,
    configLabel: args.configLabel,
    input: args.input,
    requestCount: args.requests.length,
  });
  try {
    const { providerBatchId, outputFileId } = await adapterFor(args.provider).submit(
      args.requests,
      args.submitMeta,
    );
    return (
      (await updateBatchJob(job.id, {
        providerBatchId,
        providerOutputFileId: outputFileId,
        status: "in_progress",
      })) ?? job
    );
  } catch (e) {
    await updateBatchJob(job.id, { status: "failed", error: msg(e) });
    throw e;
  }
}

// Advance one job by a single poll step. Returns the freshest row.
export async function advanceJob(job: BatchJob): Promise<BatchJob> {
  if (!job.providerBatchId) return job;
  const adapter = adapterFor(job.provider);
  let current = job;

  // Refresh provider status while still running / winding down a cancel.
  if (job.status === "in_progress" || job.status === "canceling") {
    const st = await adapter.poll(job.providerBatchId);
    // A cancel that the provider reports as "ended" is a cancellation for us —
    // don't fall through and apply a batch the user asked to stop.
    let next = st.status;
    if (job.status === "canceling" && next === "completed") next = "canceled";
    current =
      (await updateBatchJob(job.id, {
        status: next,
        requestCount: st.requestCount || job.requestCount,
        succeededCount: st.succeededCount,
        erroredCount: st.erroredCount,
        providerOutputFileId: st.outputFileId ?? job.providerOutputFileId,
        completedAt: next === "completed" ? new Date() : undefined,
      })) ?? job;
  }

  if (current.status === "completed") return applyJob(current);
  if (current.status === "canceled" || current.status === "failed" || current.status === "expired") {
    return maybeNotify(current);
  }
  return current;
}

async function applyJob(job: BatchJob): Promise<BatchJob> {
  const handler = handlerFor(job.kind);
  if (!handler) {
    return (
      (await updateBatchJob(job.id, { status: "failed", error: `No handler for ${job.kind}` })) ??
      job
    );
  }
  try {
    const results = await adapterFor(job.provider).results(
      job.providerBatchId!,
      job.providerOutputFileId,
    );
    const run = () => handler.apply(job.input, results);
    const resolved = job.configId ? await resolveConfig(job.configId) : null;
    const applied = resolved ? await withConfig(resolved, run) : await run();
    const updated =
      (await updateBatchJob(job.id, {
        status: "applied",
        appliedCount: applied,
        appliedAt: new Date(),
      })) ?? job;
    return maybeNotify(updated);
  } catch (e) {
    const failed = (await updateBatchJob(job.id, { status: "failed", error: msg(e) })) ?? job;
    return maybeNotify(failed);
  }
}

// Fire the completion email once (best-effort), stamping email_sent so a later
// poll doesn't re-send.
async function maybeNotify(job: BatchJob): Promise<BatchJob> {
  if (job.emailSent) return job;
  const sent = await sendCompletionEmail(job);
  return sent ? ((await updateBatchJob(job.id, { emailSent: true })) ?? job) : job;
}

// The panel's poll / "Check now": advance every active job, then return the full
// (newest-first) list for the UI. One slow/failed job never blocks the rest.
export async function pollAndApply(): Promise<BatchJob[]> {
  const active = await listActiveJobs();
  for (const job of active) {
    try {
      await advanceJob(job);
    } catch (e) {
      console.warn(`[batch:orchestrator] advance ${job.id} failed: ${msg(e)}`);
    }
  }
  return listBatchJobs();
}

export async function cancelJob(id: string): Promise<BatchJob | null> {
  const job = await getBatchJob(id);
  if (!job) return null;
  if (!job.providerBatchId || job.status !== "in_progress") return job;
  await adapterFor(job.provider).cancel(job.providerBatchId);
  return updateBatchJob(id, { status: "canceling" });
}
