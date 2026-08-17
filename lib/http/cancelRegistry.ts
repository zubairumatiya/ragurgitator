// CANCELLING AN IN-FLIGHT NDJSON RUN.
//
// An NDJSON producer is deliberately detached from the request that started it, so
// closing the tab does NOT stop it: `enqueue` throws, the error is swallowed, and
// the loop keeps spending. This registry is the missing back channel — one
// process-local map of the runs currently streaming, so a second request can flip a
// flag the producer's loops read between units of work.
//
// CANCELLATION IS A FLAG, NEVER AN EXCEPTION. The whole run is one transaction that
// commits when the stream ends, so throwing out of a loop would roll back every
// question the run already generated and streamed to the screen — tokens spent,
// output discarded, question_cache banking gone with it. Loops must BREAK and
// return normally; partial work commits and "Score pending" finishes the rest.
// Anything that reads isCancelled() and throws re-introduces exactly the bug this
// exists to avoid.
//
// It follows that cancellation is COOPERATIVE and not instant: the run stops at its
// next checkpoint, which for an in-flight LLM call is when that call returns.
//
// Process-local by design. On a multi-instance deployment a cancel that lands on
// another instance finds nothing and reports `found: false`, which the UI treats as
// "already over" — the honest answer when we cannot reach the run. Durable
// cross-instance cancellation would need the flag in Postgres.
//
// globalThis-backed for the same reason the pools are: HMR re-evaluates modules in
// dev, and a fresh Map would orphan every run registered against the old one.

type ActiveRun = { userId: string; cancelled: boolean };

// What a long-running job polls between units of work. Named here rather than in
// eval.ts so the ranking module can take one without importing the eval module.
export type ShouldStop = () => boolean;

// The default for every job's `shouldStop` parameter: the callers that aren't a
// stream (autotune's internal re-scores, the single-question paths, tests) have
// nothing to cancel and shouldn't have to say so.
export const NEVER_STOP: ShouldStop = () => false;

declare global {
  var __ragActiveRuns: Map<string, ActiveRun> | undefined;
}

const runs: Map<string, ActiveRun> =
  globalThis.__ragActiveRuns ?? new Map<string, ActiveRun>();

if (process.env.NODE_ENV !== "production") globalThis.__ragActiveRuns = runs;

// Register a run as in flight and return its id. Called by ndjsonStream before
// the Response is returned, so the id is on the wire (as `run-started`) before
// any work the client might want to cancel has happened.
export function registerRun(userId: string): string {
  const runId = crypto.randomUUID();
  runs.set(runId, { userId, cancelled: false });
  return runId;
}

// Register a run under an id the CLIENT chose. The NDJSON path can hand its id
// back on the wire before any work happens; a plain JSON POST cannot — its
// response only exists once the work is over — so the long-running ones let the
// caller name the run up front instead.
//
// Refuses an id already in flight (returns false) rather than overwriting it:
// otherwise a second run could silently take over the first one's cancel
// channel, or a guessed id could bind a stranger's cancel button to your run.
// The caller treats false as "no cancel channel", not as a failure to start.
export function registerRunId(runId: string, userId: string): boolean {
  if (runs.has(runId)) return false;
  runs.set(runId, { userId, cancelled: false });
  return true;
}

// Drop a finished run. Idempotent — the stream's `finally` is the only caller,
// but it runs on the error and client-disconnect paths too.
export function unregisterRun(runId: string): void {
  runs.delete(runId);
}

// Ask a run to stop at its next checkpoint. Returns false when the id is
// unknown (finished, never existed, or streaming from another instance) OR when
// it belongs to a different user — the two are deliberately indistinguishable
// to the caller, so this cannot be used to probe for other users' run ids.
export function requestCancel(runId: string, userId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.userId !== userId) return false;
  run.cancelled = true;
  return true;
}

// The predicate the producer's loops poll. Unknown ids read as NOT cancelled:
// an unregistered run is one nobody can be waiting on.
export function isCancelled(runId: string): boolean {
  return runs.get(runId)?.cancelled ?? false;
}

// Test seam only — clears every registration.
export function resetRunsForTest(): void {
  runs.clear();
}
