// ORCHESTRATOR — threads store ↔ providers ↔ job handlers ↔ notify.
//
//   submitBatch  — create the row, submit to the provider, stamp the id (or fail).
//   pollAndApply — the "Check now" / poll-while-open entry: advance every active job
//                  one step (refresh status; apply on completion; notify).
//   cancelJob    — provider cancel + local status.
//
// Apply runs inside the job's config scope since the handlers read
// activeConfig()-scoped tables, and it runs LATE — long after the original request.
// Handlers are idempotent, so the modest double-apply window from two overlapping
// polls is harmless.
import { withConfig, resolveConfig } from "@/lib/rag/activeConfig";
import { activeUser } from "@/lib/auth/userScope";
import {
  createBatchJob,
  failStaleSubmittingJobs,
  getBatchJob,
  hasOpenJobOfKind,
  listActiveJobs,
  listBatchJobs,
  updateBatchJob,
} from "@/lib/rag/batchStore";
import { adapterFor, type SubmitMeta } from "@/lib/batch/providers";
import { handlerFor, type JobHandler } from "@/lib/batch/jobs/registry";
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
  if (job.status === "in_progress" || job.status === "cancelling") {
    const st = await adapter.poll(job.providerBatchId);
    // A cancel that the provider reports as "ended" is a cancellation for us —
    // don't fall through and apply a batch the user asked to stop.
    let next = st.status;
    if (job.status === "cancelling" && next === "completed") next = "cancelled";
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
  if (current.status === "cancelled" || current.status === "failed" || current.status === "expired") {
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
    // handler.apply banks the batch discount itself (it runs in the job's config
    // scope and owns the token counts) — docs/savings-accounting-plan.md §2 #4.
    const run = () => handler.apply(job.input, results);
    const resolved = job.configId ? await resolveConfig(job.configId) : null;
    const applied = resolved ? await withConfig(resolved, run) : await run();
    const updated =
      (await updateBatchJob(job.id, {
        status: "applied",
        appliedCount: applied,
        appliedAt: new Date(),
      })) ?? job;
    // The follow-on batch, if this kind wants one (cache_pair_generation →
    // cache_pair_screen). AFTER the status write, so a chain that throws can
    // never un-apply results that are already in the tables, and best-effort for
    // the same reason: an unscreened pair set is recoverable by hand, a batch
    // marked failed after its rows landed is not.
    const chain = () => chainFrom(updated, handler);
    await (resolved ? withConfig(resolved, chain) : chain());
    return maybeNotify(updated);
  } catch (e) {
    const failed = (await updateBatchJob(job.id, { status: "failed", error: msg(e) })) ?? job;
    return maybeNotify(failed);
  }
}

// Submit the batch a finished job asks to follow it with.
//
// GUARDED AGAINST DOUBLE SUBMISSION. applyJob can legitimately run twice — two
// overlapping polls, or a re-poll of a completed row — and the handlers are
// idempotent, but a second SUBMIT is not: the chained build reads rows the first
// chained batch has not come back to write yet, so it would find the same work
// and pay for it again. So a SINGLETON kind with an open job is skipped — the
// same guard POST /api/batch/submit applies to a hand-launched one.
async function chainFrom(job: BatchJob, handler: JobHandler): Promise<void> {
  if (!handler.chain) return;
  try {
    const next = await handler.chain(job.input, job.appliedCount);
    if (!next) return;
    const nextHandler = handlerFor(next.kind);
    if (!nextHandler) return;
    if (nextHandler.singleton && (await hasOpenJobOfKind(next.kind))) return;
    const built = await nextHandler.build(next.scope);
    if (!built || built.requests.length === 0) return;
    await submitBatch({
      kind: next.kind,
      provider: built.provider,
      configId: job.configId,
      configLabel: job.configLabel,
      requests: built.requests,
      input: built.input,
      submitMeta: built.submitMeta,
    });
  } catch (e) {
    console.warn(`[batch:orchestrator] chain from ${job.id} failed: ${msg(e)}`);
  }
}

// Fire the completion email once (best-effort), stamping email_sent so a later
// poll doesn't re-send.
//
// The recipient is the OWNER of the batch, taken from the scope this poll is
// running in — never a deployment-wide address. pollAndApply is always entered
// under the user whose jobs it advances, so activeUser() is that owner.
async function maybeNotify(job: BatchJob): Promise<BatchJob> {
  if (job.emailSent) return job;
  const sent = await sendCompletionEmail(job, activeUser().email);
  return sent ? ((await updateBatchJob(job.id, { emailSent: true })) ?? job) : job;
}

// The panel's poll / "Check now": advance every active job, then return the full
// (newest-first) list for the UI. One slow/failed job never blocks the rest.
//
// The sweep goes first and is deliberately part of the same tick rather than a
// mechanism of its own: `submitting` is the one state nothing else can move, so
// without it a crashed submit is stranded in the panel permanently. It only
// touches rows old enough to be dead and holding no provider batch — see
// failStaleSubmittingJobs. Best-effort: a failed sweep must not cost us the
// poll, which is the part that applies finished work.
export async function pollAndApply(): Promise<BatchJob[]> {
  try {
    const swept = await failStaleSubmittingJobs();
    if (swept > 0) {
      console.warn(`[batch:orchestrator] failed ${swept} stranded submitting job(s)`);
    }
  } catch (e) {
    console.warn(`[batch:orchestrator] stale-submit sweep failed: ${msg(e)}`);
  }
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

// Cancel is a message to the PROVIDER, so it needs a provider_batch_id — which
// is exactly why `submitting` is not cancellable and isCancelable (lib/batch/
// types) must keep agreeing with this guard. When the two disagreed, the panel
// drew a Cancel button on submitting rows that fell straight through this line
// and did nothing.
export async function cancelJob(id: string): Promise<BatchJob | null> {
  const job = await getBatchJob(id);
  if (!job) return null;
  if (!job.providerBatchId || job.status !== "in_progress") return job;
  await adapterFor(job.provider).cancel(job.providerBatchId);
  return updateBatchJob(id, { status: "cancelling" });
}
