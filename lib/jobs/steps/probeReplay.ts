// Probe replay as a resumable step (docs/probe-replay-plan.md, Phase 2).
//
// WHY THE BACKGROUND, for the same reason re-score is here: the work is N sequential
// round trips and N is the size of the pair table. Inline it would hold a request
// open for minutes and be uncancellable for the duration.
//
// THE CURSOR CARRIES THE WHOLE SAMPLE, not just where we got to, and that is the one
// decision in this file worth arguing about. The obvious alternative — re-run
// eligiblePairs() each slice and take the next N — is wrong here for two independent
// reasons:
//
//   1. THE WORK CONSUMES ITS OWN ELIGIBILITY. A probed variant has a shadow row, so
//      it drops out of eligiblePairs on the next call. Re-taking "the top 40" each
//      slice would pull in 40 pairs the plan never counted, and a capped run would
//      quietly probe several times its cap. (Bulk nDCG gets away with re-deriving
//      its pending set precisely because it has no cap.)
//   2. A FAILED PROBE STAYS ELIGIBLE. Re-deriving would hand the same failing pair
//      to every subsequent slice for ever; indexing into a frozen list walks past it.
//      A later top-up run finds it eligible again, which is the right amount of
//      retry — one per run, not one per slice.
//
// So plan() chooses the sample once and run() indexes into it. Forty uuids in jsonb
// is a cheap price for a run that means what it planned.
//
// UNITS ARE PROBES ATTEMPTED, not shadow rows written. A probe with no reachable
// cache entry at all (F1's dead-origin case) records no row and is still a unit of
// work that happened; counting rows would stall the bar on exactly the pairs that
// have nothing to say.
import type { JobStep } from "@/lib/jobs/types";
import {
  eligiblePairs,
  probePairsByIds,
  replayPairs,
  selectProbes,
  PROBE_CAP,
} from "@/lib/rag/probeReplay";

export type ProbeReplayScope = { cap?: number };
export type ProbeReplayCursor = {
  // The frozen sample, in probe order. Chosen by plan(), never re-derived.
  pairIds: string[];
  // How many of them have been ATTEMPTED. Indexes into pairIds.
  attempted: number;
  // Of those, how many threw. Carried in the cursor rather than recomputed because
  // finalize() only gets the cursor, and a run's failure count has to survive the
  // slice boundary to reach the completion email.
  failed: number;
};

// STRINGS, not numbers, and deliberately so: notify.ts renders any numeric result
// between 0 and 1 as a percentage, so a run that probed exactly one pair would be
// emailed as "100.0%". Sentences also let the result say the thing that matters
// most about this job, which is what it did NOT do.
export type ProbeReplayResult = {
  probes: string;
  verdicts: string;
};

export const START: ProbeReplayCursor = { pairIds: [], attempted: 0, failed: 0 };

// One probe is an embed (content-addressed, so usually a cache read) plus one indexed
// single-row match. A slice of these is fast; the batch exists only so a stop is
// noticed promptly without re-entering replayPairs per probe.
const BATCH = 10;

export const probeReplayStep: JobStep<
  ProbeReplayScope,
  ProbeReplayCursor,
  ProbeReplayResult
> = {
  async plan(scope) {
    const sample = selectProbes(await eligiblePairs(), scope.cap ?? PROBE_CAP);
    return {
      totalUnits: sample.length,
      cursor: { pairIds: sample.map((p) => p.pairId), attempted: 0, failed: 0 },
    };
  },

  async run(scope, cursor, emit, shouldStop) {
    // A null cursor means no plan() ran for this job. The runner always supplies one,
    // but re-planning here keeps the step honest when it is driven directly — from a
    // script, or a test.
    const state =
      cursor && cursor.pairIds.length > 0 ? cursor : (await this.plan(scope)).cursor;

    const pairs = await probePairsByIds(state.pairIds);
    let attempted = state.attempted;
    let failed = state.failed;

    // Nothing to do is a SUCCESS, not an error. The common reason for it is the good
    // one — every eligible pair already has a shadow row — and the other (an ingest
    // rotated the fingerprint, so nothing is reachable) is not a failure either: no
    // work was owed.
    while (attempted < pairs.length && !shouldStop()) {
      const batch = pairs.slice(attempted, attempted + BATCH);
      const base = attempted;
      await replayPairs(batch, shouldStop, (done, failure) => {
        attempted = base + done;
        if (failure) failed += 1;
        emit({
          doneUnits: attempted,
          message: `Probed ${attempted} of ${pairs.length} pairs`,
          // Background mode drops `event`, so a swallowed probe failure exists
          // nowhere else — without this the job reports a clean run over work it
          // dropped (0066).
          failure,
        });
      });
    }

    return {
      cursor: { pairIds: state.pairIds, attempted, failed },
      done: attempted >= pairs.length,
      doneUnits: attempted,
    };
  },

  // No tail to run and nothing to freeze — this exists purely to put a sentence in
  // the completion email, and the second sentence is the load-bearing one. A user
  // who reads "probe replay is done" and goes looking for a moved calibration curve
  // has been misled by their own job panel; the rows are unjudged BY DESIGN, and the
  // curve only moves when someone works the queue.
  async finalize(_scope, cursor) {
    const state = cursor ?? START;
    const probed = state.attempted - state.failed;
    return {
      probes:
        `${probed} probe${probed === 1 ? "" : "s"} added to the shadow queue` +
        (state.failed > 0 ? ` (${state.failed} failed)` : ""),
      verdicts:
        "none written — these rows are unjudged on purpose, so the calibration " +
        "curve moves only as you accept or reject them",
    };
  },
};
