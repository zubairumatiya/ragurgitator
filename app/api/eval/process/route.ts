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

export async function POST(request: Request) {
  // NO DEMO GATE, deliberately. What this costs is one retrieval per PENDING
  // question, and for a guest that set is scoped to the twelve tunable questions
  // by the frozen rows a publish writes (lib/demo/frozen) — questionsNeedingScoring
  // skips the rest. A guest's own hand-written question is not frozen, so this is
  // the button that makes "add a question" mean something.
  return withRequestConfig(request, async () => {
    return ndjsonStream<EvalEvent>(async (send, shouldStop) => {
      try {
        await scorePendingQuestions(send, shouldStop);
      } catch (err) {
        send(streamError(err, "Scoring failed."));
      }
    });
  });
}
