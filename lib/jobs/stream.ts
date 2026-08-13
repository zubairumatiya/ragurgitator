// THE STREAMING DRIVER — the second way to run a JobStep.
//
// A step describes work that can stop and resume (lib/jobs/types.ts). The
// background runner uses that to survive a function timeout; this driver simply
// never stops early, because an NDJSON request has no deadline to respect — only
// the user's cancel. Same step, same events, same tail.
//
// Why a driver at all, rather than a plain call: `run` returns when it has done a
// batch's worth of work, so someone has to loop it, and the cancel/finalize rule
// ("a cancelled run does not run the tail") has to be applied identically in both
// drivers or the two paths quietly disagree about whether a partial run may freeze
// a snapshot.
import { recordTiming } from "@/lib/jobs/timing";
import type { JobKind, JobStep, JobProgress, StopSignal } from "@/lib/jobs/types";

export type StreamedRun<R> = {
  doneUnits: number;
  cancelled: boolean;
  // Present only when the run completed — finalize is the tail a cancelled run
  // has not earned.
  result: R | null;
};

export async function runStepStreamed<S, C, R, E>(
  kind: JobKind,
  step: JobStep<S, C, R, E>,
  scope: S,
  emit: (event: E) => void,
  shouldStop: StopSignal,
): Promise<StreamedRun<R>> {
  const t0 = Date.now();
  const { cursor: start } = await step.plan(scope);
  let cursor = start;
  let doneUnits = 0;
  let done = false;
  // Same rule as the background runner (0067): once the step is closing its books,
  // the cancel no longer ends the loop. There is no deadline on this path, so the
  // tail simply runs — which is what the streamed autotune has always done, and
  // now says so through the contract instead of through its own control flow.
  let mustFinish = false;

  for (;;) {
    const slice = await step.run(
      scope,
      cursor,
      (progress: JobProgress<E>) => {
        if (progress.event !== undefined) emit(progress.event);
      },
      // Wrapped, but the REASON is passed straight through: a step in its tail
      // must still be able to tell why it was asked to stop.
      Object.assign(() => shouldStop() && !mustFinish, { reason: shouldStop.reason }),
    );
    cursor = slice.cursor;
    doneUnits = slice.doneUnits;
    done = slice.done;
    mustFinish = mustFinish || slice.mustFinish === true;
    if (done) break;
    // Not done, and the step returned anyway: it saw shouldStop(). Loop only if
    // that is no longer true, so a step that returns for its own reasons still
    // makes progress rather than spinning.
    if (shouldStop() && !mustFinish) break;
  }

  const cancelled = shouldStop();
  // Keyed on `done` rather than on the cancel flag: finalize is the tail a run
  // that did not finish has not earned, and "did not finish" is what the step
  // reports. The two coincide for a step with no mustFinish tail; for one that
  // has, a cancelled run reaches the end of its tail and its numbers are real.
  const result = !done || !step.finalize ? null : await step.finalize(scope, cursor);
  // The streamed path is where the estimates come from in practice: it is the
  // button people press before they have ever run a background job, and its
  // timings are what decide whether the offer is made at all.
  await recordTiming(kind, doneUnits, Date.now() - t0);
  return { doneUnits, cancelled, result };
}
