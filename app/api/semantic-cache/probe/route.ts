// API route: POST /api/semantic-cache/probe
//
// ONE probe, chosen by the server, landing one unjudged row in §3's Accept /
// Reject queue (docs/demo-cache-lab-plan.md, Phase 4).
//
// WHY THIS EXISTS BESIDE A BLOCKED JOB, since merged main took the opposite
// position on purpose. `probe_replay` ships blocked in the demo —
// DEMO_ACTION_FOR_JOB in app/api/jobs/route.ts, with DEMO_ACTIONS.probeReplay's
// sentence: "every probe is an embedding a guest did not pay for". That is right
// about the JOB, whose cap is 40 probes fired automatically by a trigger nobody
// pressed, and it does not settle the ACTION. One probe is one embedQueryCached
// (content-addressed, so often not even a call) plus one indexed single-row
// lookup: the same ~25 KB a guest spends asking a question, which lib/demo/policy
// already funds and calls "the demo".
//
// So the split this route implements: the bulk job stays blocked, its gate and
// its sentence untouched, and triggerProbeReplay keeps its own demoBlocks()
// self-check so nothing AUTO-fires in a guest workspace. What a visitor gets is a
// door they have to open themselves, one row at a time.
//
// NOT ROUTED THROUGH launchJob, deliberately. The job's cap (PROBE_CAP),
// its frozen cursor and its one-run-per-config lock are all machinery for a run
// of 40; a single probe needs none of it, and reusing it would mean either a
// second demo carve-out inside app/api/jobs or a cap of 1 threaded through a
// registry. Calling replayPairs with a one-element list leaves every one of those
// exactly as it is — this route and the job share the WORK and nothing else.
//
// TAKES NO INPUT. Not a convenience: an unbounded body is how "one probe" becomes
// N, and a caller-supplied pair id is how a quarantined pair gets probed on
// purpose. The server chooses, from the post-screen survivors, by the same rule
// the bulk job would have used first.
import { config } from "@/lib/config";
import { assertDemoEmbedBudget } from "@/lib/demo/budget";
import { demoBlocks, GUEST_PROBE_NOTE } from "@/lib/demo/policy";
import { NEVER_STOP } from "@/lib/http/cancelRegistry";
import { withRequestConfig } from "@/lib/http/configScope";
import {
  eligiblePairs,
  poolSafeProbes,
  probeRow,
  recordProbeAttempt,
  replayPairs,
  selectOneProbe,
} from "@/lib/rag/probeReplay";

// The reason a config-scoped route says nothing happened. Both of these are
// ordinary outcomes rather than errors, so they come back 200 with a sentence —
// and the second one is the cause nobody guesses (probeReplayTrigger.ts says it
// the same way): eligibility is scoped by fingerprint, so an ingest since the
// last ask makes every banked answer unreachable.
const NOTHING_ELIGIBLE =
  "No probe to run — a pair only becomes probeable once its origin question has " +
  "been asked under the current index, and every one that has is already in the " +
  "queue.";

export async function POST(request: Request) {
  return withRequestConfig(request, async () => {
    // THE BUDGET, CHECKED HERE AS WELL AS AT THE DISPATCHER. embed() already
    // calls this, so the ceiling holds either way — but replayPairs SWALLOWS a
    // failed probe by design (one bad probe must not end a bulk pass), which
    // would turn an exhausted demo budget into a generic 500 instead of the 403
    // and the sentence lib/demo/policy wrote for it. Checked before the work, so
    // the refusal is the refusal and not a report of one.
    await assertDemoEmbedBudget();

    // Quarantined pairs are dropped BEFORE the choice and the chosen one is
    // asserted clean inside selectOneProbe. Phase 3b's order — screen, then
    // quarantine, then probe — is what stops F3's 15 disproved pairs reaching
    // §3's queue, and the assertion is what makes a future eligibility query that
    // forgets the filter fail loudly rather than stock the queue with them.
    const candidates = poolSafeProbes(await eligiblePairs());
    const pair = selectOneProbe(candidates);
    if (!pair) {
      return Response.json({
        probed: false,
        pair: null,
        reason: NOTHING_ELIGIBLE,
      });
    }

    // THE REAL FLOOR, not PROBE_LOOKUP's 0. A research pass records everything
    // because "below the floor" is meaningless to it (F2); a guest's probe is
    // stocking a queue whose other rows came from lib/demo/clone step 5b, which
    // strides a sample at this same floor. A 0.4 near-miss sitting among them
    // would be a row about the demo rather than about the cache, and the visitor
    // judging it could not tell.
    const floor = config.semanticCache.shadowLogFloor;

    let failure: string | null = null;
    const run = await replayPairs(
      [pair],
      NEVER_STOP,
      (_attempted, why) => {
        if (why) failure = why;
      },
      floor,
    );
    if (run.probed !== 1) {
      return Response.json(
        { error: failure ?? "The probe failed." },
        { status: 500 },
      );
    }

    // Read back rather than inferred. semanticCacheLookup reports a miss with no
    // similarity attached — serving is off, so a probe is always a miss — and the
    // shadow row is the only place the number it measured exists.
    //
    // A null row is not a failure: eligibility proved the origin is banked and
    // reachable, so there WAS a nearest match and it simply fell below the floor.
    // The panel can say that; what it may not say is "your pair, replayed", since
    // the nearest match is not guaranteed to be the origin (replayPairs' own
    // caveat, and F1's dead-origin lesson).
    // BEFORE the read-back, so the pair leaves the eligible pool whichever way the
    // lookup went. Above the floor a shadow row already excludes it; below the
    // floor nothing was written, and without this the next call re-selects this
    // very pair — selectProbes is a total order, so the button would hand out
    // 003ea129 forever while `remaining` never moved.
    await recordProbeAttempt(pair.variantText);

    const row = await probeRow(pair.variantText);
    return Response.json({
      probed: true,
      pair: {
        pairId: pair.pairId,
        originText: pair.originText,
        variantText: pair.variantText,
        difficulty: pair.difficulty,
      },
      floor,
      // Whether it cleared the floor, i.e. whether a row landed in the queue.
      queued: row !== null,
      sim: row?.sim ?? null,
      matchedQuery: row?.matchedQuery ?? null,
      // Always null. Stated as a field rather than left out because it is the
      // module's central rule and the panel is the place a visitor could most
      // easily be misled about it: nothing has judged this row but them.
      verdict: null,
      // How many more probes this workspace could run, so a button can stop
      // offering one that would come back NOTHING_ELIGIBLE. Minus this probe,
      // which consumed its own eligibility (lib/jobs/steps/probeReplay.ts).
      remaining: Math.max(candidates.length - 1, 0),
      // The demo's sentence, for the demo only — a real account is not spending
      // anyone else's budget and does not need to be told what a probe costs.
      // demoBlocks() is the courtesy read, never the gate here: this route has no
      // gate, because a single probe is a thing a guest may do.
      note: (await demoBlocks()) ? GUEST_PROBE_NOTE : null,
    });
  });
}
