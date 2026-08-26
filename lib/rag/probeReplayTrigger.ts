// PROBE REPLAY — the trigger (docs/probe-replay-plan.md, Phase 3).
//
// Phases 1 and 2 built the work and made it resumable; nothing fired it. This is
// the door, and there is deliberately no button behind it: the moment a user's
// pair bank grows is the moment §3's queue can grow, and asking them to notice
// that and press something is asking them to know the mechanism.
//
// A TOP-UP, NOT A ONE-SHOT. plan() re-derives eligiblePairs() every launch, so
// each firing takes whatever has become eligible since the last one. That matters
// because eligibility is not fixed at generation time: a pair generated today for
// a question nobody has asked becomes eligible the moment someone asks it, and an
// ingest that rotates the answer-cache fingerprint takes eligibility back to ~0
// until questions are re-asked (see the clone/fingerprint collision). Generation
// is the trigger of CONVENIENCE — the point where new pairs certainly exist — not
// a claim that it is the only moment new probes appear.
//
// BEST-EFFORT, ALWAYS. Pair generation has already spent its money and written
// its rows by the time this runs. A probe job that fails to launch leaves the
// queue exactly as short as it already was; failing the generation over it would
// throw away paid work to report a free thing not happening.
import { demoBlocks } from "@/lib/demo/policy";
import { launchJob } from "@/lib/jobs/runner";
import { activeJobsForConfig } from "@/lib/jobs/store";
import type { BackgroundJob } from "@/lib/jobs/types";
import { activeConfig } from "@/lib/rag/activeConfig";
import { eligiblePairs } from "@/lib/rag/probeReplay";

export type ProbeTrigger =
  | { launched: true; job: BackgroundJob; eligible: number }
  // Why nothing happened, in words a panel can print. A null reason is the
  // ordinary "nothing to do", which is not worth a sentence.
  | { launched: false; job: null; eligible: number; reason: string | null };

const none = (reason: string | null): ProbeTrigger => ({
  launched: false,
  job: null,
  eligible: 0,
  reason,
});

// Launch a top-up probe run for the ACTIVE config, if there is one worth
// launching. Callers run it once pairs have landed, and ignore the result if they
// have nowhere to put it.
export async function triggerProbeReplay(): Promise<ProbeTrigger> {
  try {
    // A guest never reaches here through the front door — pair generation is
    // behind assertDemoAllows("sweep") — so this is belt and braces for a future
    // caller, and it RETURNS rather than throws: a trigger is not an entry point,
    // and a gate that threw here would turn "the demo doesn't do this" into a
    // failed generation. The enforcing gate is /api/jobs' DEMO_ACTION_FOR_JOB.
    if (await demoBlocks()) return none(null);

    // One run at a time per config. Two overlapping runs would each freeze their
    // own sample from the same eligible set and probe most of it twice — the
    // second run's rows dedupe on recordShadow's conflict key, so the damage is
    // wasted embeddings rather than bad data, but it is still a doubled bill for
    // a job whose whole appeal is that it is nearly free.
    const running = await activeJobsForConfig(activeConfig().id, ["probe_replay"]);
    if (running.length > 0) {
      // Neither an error nor silent: the running job is a top-up too, but it
      // froze its sample BEFORE these pairs existed, so they wait for the next
      // firing rather than joining it (lib/jobs/steps/probeReplay.ts).
      return none("A probe run is already going; the new pairs go into the next one.");
    }

    // Derived here and again in plan(). Deliberate: deriving eligibility consumes
    // nothing (only probing does), the query is two indexed reads, and the
    // alternative is creating a zero-unit job row after every generation run on
    // an account whose questions have never been asked — a panel full of jobs
    // that did nothing is how a panel stops being read.
    const eligible = await eligiblePairs();
    if (eligible.length === 0) {
      return none(
        // The common cause on a real account, and the one nobody guesses: the
        // lookup is scoped by fingerprint, so an ingest since the last ask makes
        // every banked answer unreachable. Said plainly, because an empty result
        // with no explanation reads as a broken feature.
        "No probes to queue — a pair only becomes probeable once its origin " +
          "question has been asked under the current index.",
      );
    }

    const job = await launchJob("probe_replay", {});
    return { launched: true, job, eligible: eligible.length };
  } catch (err) {
    console.warn(
      `[rag:probe-replay] trigger failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return none(null);
  }
}

// The sentence a panel prints for a trigger outcome, or null when there is
// nothing worth saying. It lives beside the trigger so both call sites word it
// the same way, and it is phrased around the QUEUE rather than the job: what the
// user gets is rows to judge, and the job is only the plumbing that makes them.
export function probeTriggerNote(t: ProbeTrigger): string | null {
  if (!t.launched) return t.reason;
  const n = t.job.totalUnits;
  if (n === 0) return null;
  return (
    `Queued ${n} probe${n === 1 ? "" : "s"} for the shadow judge` +
    (t.eligible > n ? ` (${t.eligible} eligible; the rest wait for the next run)` : "") +
    " — they land unjudged, so the calibration curve moves only as you accept or reject them."
  );
}
