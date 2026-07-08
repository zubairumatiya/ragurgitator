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
  // Optional body { documentId } — the bulk-actions document scope. Older
  // callers send no body; non-JSON is treated as absent.
  const raw = (await request.json().catch(() => null)) as { documentId?: unknown } | null;
  const documentId =
    typeof raw?.documentId === "string" ? raw.documentId : undefined;

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await rescoreAllQuestions(send, documentId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Re-scoring failed.";
        send({ type: "error", message });
      }
    }),
  );
}
