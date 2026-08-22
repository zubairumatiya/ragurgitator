// API route: POST /api/eval/process
//
// Scores every question that has no fresh result — new, edited, or stale after a
// retrieval change — and freezes a run snapshot. Incremental and cheap: it GENERATES
// NOTHING (that is Bulk actions → Add, the only path that can also route generation
// through the batch API). Backs the "Score pending" button. Streams progress as
// NDJSON so the dashboard can show a live bar + per-question results.
//
// The path keeps its old name deliberately — one caller, no churn, no stale
// bookmarks.
import { streamError } from "@/lib/http/missingKeyServer";
import { scorePendingQuestions, type EvalEvent } from "@/lib/rag/eval";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";
import { assertDemoAllows } from "@/lib/demo/policy";

export async function POST(request: Request) {
  return withRequestConfig(request, async () => {
    await assertDemoAllows("rescore");
    return ndjsonStream<EvalEvent>(async (send, shouldStop) => {
      try {
        await scorePendingQuestions(send, shouldStop);
      } catch (err) {
        send(streamError(err, "Scoring failed."));
      }
    });
  });
}
