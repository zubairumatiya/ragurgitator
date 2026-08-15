// THE STREAMING DRIVER — the second way to run a JobStep.
//
// A step describes work that can stop and resume (lib/jobs/types.ts). The
// background runner uses that to survive a function timeout; this driver stops
// early only to COMMIT, because an NDJSON request has no deadline to respect —
// only the user's cancel. Same step, same events, same tail.
//
// Why a driver at all, rather than a plain call: `run` returns when it has done a
// batch's worth of work, so someone has to loop it, and the cancel/finalize rule
// ("a cancelled run does not run the tail") has to be applied identically in both
// drivers or the two paths quietly disagree about whether a partial run may freeze
// a snapshot.
//
// EACH SLICE COMMITS (docs/autotune-slicing-fixes-plan.md §D). This loop used to
// run inside the single scope lib/http/ndjson.ts opened for it, which made a
// streamed run one transaction for its entire length — nothing durable until the
// request ended, so a statement error an hour in discarded overrides confirmed
// through real retrieval and left their provider spend billed. Wrapping each
// iteration in its own scope gives this driver the durability the background
// runner gets from its slice boundary. Durability comes from the COMMIT; the
// cursor only says where to carry on, and it can stay in a local variable here
// because it only has to survive the loop, not a process restart.
//
// STOPPING AND YIELDING ARE DIFFERENT THINGS, and conflating them is what kept
// the observed failure alive through a fix written for it. A step's tail declares
// `mustFinish` — the accounting is not optional — which suppresses the cancel, and
// with only one signal that also suppressed the one asking it to hand back. So the
// whole tail ran in a single step.run() call inside a single transaction, and a
// 470-question re-score died on the lock pool at the same question every time.
//
//   the wrapped cancel  stop doing this work; the run ends and its books close.
//                       suppressed by mustFinish.
//   yieldMs             return so this driver can commit, then continue.
//                       NOT suppressed by mustFinish — that is the entire point.
//
// A yield is reported to the step as `deadline`, which already means "hand back,
// another slice is coming" — so no step needs a new concept, and none of them
// writes a stop reason for it.
import { activeUser, withUser } from "@/lib/auth/userScope";
import { runOutsideUserTransaction } from "@/lib/db";
import { recordTiming } from "@/lib/jobs/timing";
import type { JobKind, JobStep, JobProgress, StopReason, StopSignal } from "@/lib/jobs/types";

// How long one streamed slice may run before handing back to commit. Measured per
// slice, not per run — an expired run-wide deadline would make every step.run()
// return immediately and the loop spin without progress.
//
// A floor rather than a ceiling: like both other stop signals it is only polled
// BETWEEN units of work, so a slice that is inside a single chunk's search when it
// expires finishes that chunk first. 60s over work whose units are seconds keeps a
// transaction small without paying a connection checkout every few questions.
export const STREAM_YIELD_MS = Number(process.env.STREAM_YIELD_MS ?? 60_000);

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
  yieldMs: number = STREAM_YIELD_MS,
): Promise<StreamedRun<R>> {
  const t0 = Date.now();
  // Read while the caller's scope is still current, so each slice below can
  // re-enter it. ndjson.ts has already put us inside the producer's own scope —
  // see its ordering note, which this must not disturb: the per-slice scope goes
  // INSIDE the bound re-entry, never around it.
  const user = activeUser();
  // Each slice runs in its own transaction on its own connection checkout, so the
  // work it did is durable before the next one starts. Nothing may hold a `sql`
  // handle across this boundary — the stores all re-read from the scope on every
  // call, which is what makes that true rather than lucky.
  const inOwnTransaction = <T>(fn: () => Promise<T>): Promise<T> =>
    runOutsideUserTransaction(() => withUser(user, fn));

  const { cursor: start } = await inOwnTransaction(() => step.plan(scope));
  let cursor = start;
  let doneUnits = 0;
  let done = false;
  // Same rule as the background runner (0067): once the step is closing its books,
  // the cancel no longer ends the loop. The tail still slices — see the yield
  // above — so this cannot become an unstoppable transaction.
  let mustFinish = false;

  for (;;) {
    const sliceStart = Date.now();
    const yielding = () => Date.now() - sliceStart > yieldMs;
    // The cancel is what mustFinish suppresses; the yield is not.
    const sliceStop: StopSignal = Object.assign(
      () => (shouldStop() && !mustFinish) || yielding(),
      {
        // Same precedence as the runner's: a real stop is reported even while
        // mustFinish is suppressing the boolean, because its only reader is a step
        // deciding whether more of the same work is coming. A yield is a deadline,
        // which is the step contract's word for "hand back, I will call you again"
        // — and the reason no step writes a stop reason for one.
        reason: (): StopReason | null =>
          shouldStop() ? (shouldStop.reason?.() ?? "cancel") : yielding() ? "deadline" : null,
      },
    );

    const slice = await inOwnTransaction(() =>
      step.run(
        scope,
        cursor,
        (progress: JobProgress<E>) => {
          if (progress.event !== undefined) emit(progress.event);
        },
        sliceStop,
      ),
    );
    cursor = slice.cursor;
    doneUnits = slice.doneUnits;
    done = slice.done;
    mustFinish = mustFinish || slice.mustFinish === true;
    if (done) break;
    // Not done, and the step returned anyway: it saw sliceStop(). Loop unless that
    // was a real stop — a yield is precisely the case that must NOT break, and
    // reading the unwrapped signal here is what keeps the two apart.
    if (shouldStop() && !mustFinish) break;
  }

  const cancelled = shouldStop();
  // Keyed on `done` rather than on the cancel flag: finalize is the tail a run
  // that did not finish has not earned, and "did not finish" is what the step
  // reports. The two coincide for a step with no mustFinish tail; for one that
  // has, a cancelled run reaches the end of its tail and its numbers are real.
  const finalize = step.finalize;
  const result =
    !done || !finalize ? null : await inOwnTransaction(() => finalize(scope, cursor));
  // The streamed path is where the estimates come from in practice: it is the
  // button people press before they have ever run a background job, and its
  // timings are what decide whether the offer is made at all.
  //
  // In its own scope like everything else, and for a reason that only appeared
  // once the slices got theirs: the transaction ndjson.ts opened is now idle for
  // the entire run, and an idle transaction is exactly what a server-side
  // idle_in_transaction timeout reaps. Leaving the last write on it would turn a
  // long, fully committed run into an error at the finish line.
  await inOwnTransaction(() => recordTiming(kind, doneUnits, Date.now() - t0));
  return { doneUnits, cancelled, result };
}
