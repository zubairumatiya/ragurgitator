// API route: POST /api/eval/rescore
//
// Re-runs retrieval scoring for EVERY labeled question under the active config
// (not just unscored ones) against the current corpus, inserts fresh result rows,
// and freezes a run snapshot. Use after the corpus changes (e.g. a doc was added)
// so Recall@k stays apples-to-apples. Backs the "Re-score all" button on /eval.
// Streams progress as NDJSON (one EvalEvent per line) for a live bar + results.
//
// The work is lib/jobs/steps/rescore.ts, driven here to completion. The SAME step
// also runs as a background job (POST /api/jobs) when the estimate says this will
// take longer than the user wants to sit with a tab open — one implementation, two
// drivers, so the two paths cannot drift.
import { streamError } from "@/lib/http/missingKeyServer";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";
import { runStepStreamed } from "@/lib/jobs/stream";
import { rescoreStep } from "@/lib/jobs/steps/rescore";
import type { EvalEvent } from "@/lib/rag/eval";
import { getSummary } from "@/lib/rag/evalStore";

export async function POST(request: Request) {
  // Optional body { documentIds } (or legacy { documentId }) — the bulk-actions
  // document scope. Older callers send no body; non-JSON is treated as absent.
  const raw = (await request.json().catch(() => null)) as {
    documentId?: unknown;
    documentIds?: unknown;
  } | null;
  const documentIds = Array.isArray(raw?.documentIds)
    ? raw.documentIds.filter((id): id is string => typeof id === "string")
    : typeof raw?.documentId === "string"
      ? [raw.documentId]
      : undefined;

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send, shouldStop) => {
      try {
        const run = await runStepStreamed(
          "rescore",
          rescoreStep,
          { documentIds },
          send,
          shouldStop,
        );
        // A cancelled run skipped finalize, so its numbers come from a plain read
        // rather than from a snapshot it did not freeze.
        const summary = run.result ?? (await getSummary());
        send({
          type: "done",
          cancelled: run.cancelled,
          generated: 0,
          scored: run.doneUnits,
          recall: summary.recall,
          mrr: summary.mrr,
          ndcg: summary.ndcg,
        });
      } catch (err) {
        send(streamError(err, "Re-scoring failed."));
      }
    }),
  );
}
