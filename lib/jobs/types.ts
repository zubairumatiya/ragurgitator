// BACKGROUND JOB TYPES — the vocabulary shared by the runner, the store, the
// routes and the panel. Pure: no database, no I/O, so the predicates below are
// unit-testable and the client can import them.
//
// The one idea worth holding onto: a background job is a SEQUENCE OF SLICES, not a
// process (see migrations/0062_background_jobs.sql for why). Everything here is
// shaped by that — a job carries where it got to (`cursor`), how far along it is,
// and whether someone currently holds the lease to advance it.

// --- kinds ------------------------------------------------------------------

// The long bulk actions. Deliberately NOT every NDJSON route: question
// generation already has a true background path through the provider batch API
// (lib/batch/jobs/questionGeneration.ts), and a second mechanism for the same
// work would just be two things to keep in agreement.
export const JOB_KINDS = ["rescore", "bulk_ndcg", "autotune", "probe_replay"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_LABELS: Record<JobKind, string> = {
  rescore: "Re-score all questions",
  bulk_ndcg: "Bulk nDCG grading",
  autotune: "Autotune",
  probe_replay: "Stock the would-hit queue",
};

// What one unit of work IS, per kind — the noun the progress bar and the ETA are
// counted in. Surfaced in the UI copy ("142 of 472 questions"), so it has to be
// the thing the user recognizes, not an internal batch size.
export const JOB_UNITS: Record<JobKind, string> = {
  rescore: "question",
  bulk_ndcg: "question",
  autotune: "chunk",
  // Not "pair": what the bar counts is probes attempted, and a pair with nothing
  // reachable to match still costs one (lib/jobs/steps/probeReplay.ts).
  probe_replay: "probe",
};

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

// --- statuses ---------------------------------------------------------------

export const JOB_STATUSES = [
  "queued",      // created, no slice has claimed it yet
  "running",     // at least one slice has run; may or may not be leased right now
  "cancelling",  // the durable cancel flag; the running slice breaks at its next checkpoint
  "cancelled",
  "succeeded",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["cancelled", "succeeded", "failed"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// Is there still work for a slice to do? `cancelling` counts: a cancelling job
// still needs one more slice to notice the flag and write the terminal status —
// nothing else moves it, exactly like batch_jobs' `submitting`.
export function isAdvanceable(status: JobStatus): boolean {
  return status === "queued" || status === "running" || status === "cancelling";
}

// Cancel is only meaningful while work remains, and asking twice is not an error
// worth surfacing — a second click on an already-cancelling job is a no-op.
export function isCancellable(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

// --- the row ----------------------------------------------------------------

export type BackgroundJob = {
  id: string;
  configId: string;
  configLabel: string;
  kind: JobKind;
  status: JobStatus;
  scope: unknown;   // the launch request, frozen at create time
  // Optional because only the lease claim selects it (lib/jobs/store.ts):
  // every other reader gets JOB_COLUMNS_LIGHT and this is absent. The
  // optionality is the point — a new reader that needs a cursor fails to
  // compile rather than silently reading undefined.
  cursor?: unknown;  // opaque here; owned by the step for this kind
  result: unknown;  // headline numbers for the email and the panel
  totalUnits: number;
  doneUnits: number;
  // Units the step swallowed a failure on (0066). Counted separately from
  // `error`, which is a whole-job death: these are holes in the work of a job
  // that otherwise finished.
  failedUnits: number;
  lastUnitError: string | null;
  lastMessage: string | null;
  // The step has left the phase that spends and is closing its books (0067). A
  // cancel no longer ends the job while this is set — see StepResult.mustFinish.
  mustFinish: boolean;
  leaseExpiresAt: string | null;
  attempts: number;
  error: string | null;
  acknowledged: boolean;
  emailSent: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

// --- progress ---------------------------------------------------------------

// 0–100, or null when we have no denominator yet. Clamped because total_units is
// an ESTIMATE from plan() — a job that finds more work than it predicted must not
// draw a bar past its end.
export function progressPercent(job: Pick<BackgroundJob, "totalUnits" | "doneUnits">): number | null {
  if (job.totalUnits <= 0) return null;
  return Math.min(100, Math.round((job.doneUnits / job.totalUnits) * 100));
}

// Seconds left, from observed throughput rather than the original estimate: once a
// job is running, what it is actually doing beats what we guessed it would do.
// Null until there is enough to divide by.
export function remainingSeconds(
  job: Pick<BackgroundJob, "totalUnits" | "doneUnits">,
  elapsedMs: number,
): number | null {
  if (job.doneUnits <= 0 || job.totalUnits <= job.doneUnits || elapsedMs <= 0) return null;
  const msPerUnit = elapsedMs / job.doneUnits;
  return Math.round(((job.totalUnits - job.doneUnits) * msPerUnit) / 1000);
}

// A job is STALLED when it should be advancing but nobody holds a live lease on
// it. That is the normal state between a slice ending and the next one starting,
// so this is only the janitor's question — never a thing to show the user as an
// error. `queued` with no lease is stalled too: it means the launch fired but the
// first tick never landed.
export function isStalled(
  job: Pick<BackgroundJob, "status" | "leaseExpiresAt">,
  now: number = Date.now(),
): boolean {
  if (!isAdvanceable(job.status)) return false;
  if (!job.leaseExpiresAt) return true;
  return new Date(job.leaseExpiresAt).getTime() <= now;
}

// --- the step contract ------------------------------------------------------

// What a bulk action must provide to be runnable in the background. The same
// implementation also backs the streaming route, so there is one description of
// the work and two drivers over it (lib/jobs/runner.ts and the NDJSON route).
//
//   plan      — count the units and produce the starting cursor. Also called on
//               its own by the ETA route, which is why it must not write anything.
//   run       — work from `cursor` until `shouldStop()` says otherwise, then
//               return where it got to. MUST break and return normally on a stop,
//               never throw: the slice's transaction commits on return, so
//               throwing out of the loop discards work already paid for
//               (lib/http/cancelRegistry.ts's rule, unchanged here).
//   finalize  — the once-per-job tail: freeze the run snapshot, compute headline
//               numbers. Runs in the LAST slice only, and only when the job was
//               not cancelled.
//
// `emit` is ONE channel carrying two audiences, which is why it has an optional
// `event`. The background runner reads `doneUnits`/`message` and drops the rest;
// the streaming route forwards `event` to the browser verbatim and drops the rest.
// A step that emitted only counters would flatten the per-question detail the eval
// dashboard already draws; two separate channels would let the two drift.
export type JobProgress<E = unknown> = {
  doneUnits: number;
  message?: string;
  event?: E;
  // "This unit failed and I carried on." Set it wherever a step catches per-unit
  // errors, which every long sweep does — one bad question must not abort the
  // run. Without this the failure exists only in `event`, which the background
  // runner drops, and the job reports having processed work it dropped (0066).
  //
  // Presence is the increment: emit it once per failed unit, not as a total.
  failure?: string;
};

// WHY a step is being asked to stop. Most steps do not care — they break out of
// their loop and return where they got to either way — but a step with a tail
// does, because the three answers mean opposite things to it:
//
//   deadline  this slice is over; hand back and we will call you again.
//   cancel    there will be no more of the work you were doing.
//   budget    the same, self-imposed: the STREAMED driver has no deadline of its
//             own, and an unsliced run is a single point of failure whose blast
//             radius grows with its length (docs/autotune-slicing-plan.md §2).
//
// Optional so the plain `() => boolean` every existing step and test passes still
// satisfies the type; a step that reads it must have a sensible default.
export type StopReason = "deadline" | "cancel" | "budget";
export type StopSignal = (() => boolean) & { reason?: () => StopReason | null };

export type StepResult<C> = {
  cursor: C;
  done: boolean;
  // Cumulative, not per-slice: the runner stores it directly, so a slice that
  // resumed at 300 reports 340, not 40. Absolute is the resumable form.
  doneUnits: number;
  // "I am past the phase that spends; what is left is accounting." Sticky once
  // set. A cancel stops reaching this step's remaining slices — the runner keeps
  // chaining rather than going terminal — while the slice DEADLINE still applies,
  // so a tail slices like any other work and cannot wedge the job.
  //
  // Only for a tail whose absence would leave the corpus inconsistent or a spend
  // unrecorded. Re-score and bulk nDCG have no such tail: cancelling them leaves
  // partial work the stale badge already accounts for. Autotune does, because its
  // search has already changed the retrieval state of every question (0067).
  mustFinish?: boolean;
};

export type JobStep<S, C, R = unknown, E = unknown> = {
  plan(scope: S): Promise<{ totalUnits: number; cursor: C }>;
  run(
    scope: S,
    cursor: C,
    emit: (progress: JobProgress<E>) => void,
    shouldStop: StopSignal,
  ): Promise<StepResult<C>>;
  finalize?(scope: S, cursor: C): Promise<R>;
};
