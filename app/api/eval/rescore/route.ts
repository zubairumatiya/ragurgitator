// ---------------------------------------------------------------------------
// API route: POST /api/eval/rescore
//
// Re-runs retrieval scoring for EVERY labeled question under the active config
// (not just unscored ones) against the current corpus, inserts fresh result rows,
// and freezes a run snapshot. Use after the corpus changes (e.g. a doc was added)
// so Recall@k stays apples-to-apples. Backs the "Re-score all" button on /eval.
// Streams progress as NDJSON (one EvalEvent per line) for a live bar + results.
// ---------------------------------------------------------------------------
import { rescoreAllQuestions, type EvalEvent } from "@/lib/rag/eval";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";

export async function POST(request: Request) {
  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await rescoreAllQuestions(send);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Re-scoring failed.";
        send({ type: "error", message });
      }
    }),
  );
}
