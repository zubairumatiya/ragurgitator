// API route: POST /api/eval/autotune
//
// Runs the Phase C autotune engine: for every question below its min-rate,
// search chunk sizes / models / combos, persist winning per-chunk overrides
// (confirmed via real retrieval), then the dirty-set re-score and the history
// row. Streams progress as NDJSON (one AutotuneEvent per line) so the dashboard
// can show live per-chunk progress and collect pending choices.
//
// The work is lib/jobs/steps/autotune.ts, driven here to completion. The SAME step
// also runs as a background job (POST /api/jobs), sliced across invocations — one
// implementation, two drivers, so a 66-minute sweep is no longer one transaction
// (docs/autotune-slicing-plan.md).
import { streamError } from "@/lib/http/missingKeyServer";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";
import { runStepStreamed } from "@/lib/jobs/stream";
import { autotuneStep, STREAM_BUDGET_MS } from "@/lib/jobs/steps/autotune";
import type { StopReason, StopSignal } from "@/lib/jobs/types";
import type { AutotuneEvent } from "@/lib/rag/autotune";
import { getSummary } from "@/lib/rag/evalStore";

export async function POST(request: Request) {
  return withRequestConfig(request, async () =>
    ndjsonStream<AutotuneEvent>(async (send, shouldStop) => {
      const t0 = performance.now();
      // The soft deadline this driver imposes on itself. A background job gets one
      // from its slice; this run's transaction is open for its entire length, so
      // the bound has to come from somewhere — see STREAM_BUDGET_MS. The reason is
      // what lets the step tell it apart from a cancel and report it honestly.
      const overBudget = () => performance.now() - t0 > STREAM_BUDGET_MS;
      const stop: StopSignal = Object.assign(() => shouldStop() || overBudget(), {
        reason: (): StopReason | null =>
          shouldStop() ? "cancel" : overBudget() ? "budget" : null,
      });
      try {
        const run = await runStepStreamed("autotune", autotuneStep, {}, send, stop);
        // Cancelling autotune stops the SEARCH, not the accounting — the step
        // declares mustFinish once it leaves that phase — so a cancelled run still
        // reaches the end and its numbers are real. The fallback covers the one
        // case that does not: a run that had nothing to target.
        const r = run.result;
        const summary = r ?? (await getSummary());
        send({
          type: "autotune-done",
          stopReason: r?.stopReason ?? (run.cancelled ? "cancelled" : null),
          chunksSearched: r?.chunksSearched ?? 0,
          chunksTotal: r?.chunksTotal ?? 0,
          targeted: r?.targeted ?? 0,
          resolved: r?.resolved ?? 0,
          unresolved: r?.unresolved ?? 0,
          improved: r?.improved ?? 0,
          pendingChoice: r?.pendingChoice ?? 0,
          attempts: r?.attempts ?? 0,
          recall: summary.recall,
          mrr: summary.mrr,
          ndcg: summary.ndcg,
          durationMs: Math.round(performance.now() - t0),
        });
      } catch (err) {
        send(streamError(err, "Autotune failed."));
      }
    }),
  );
}
