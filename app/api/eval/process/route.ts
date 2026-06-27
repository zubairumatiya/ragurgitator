// ---------------------------------------------------------------------------
// API route: POST /api/eval/process
//
// Generates questions for any new chunks, scores anything unscored, and freezes
// a run snapshot. Incremental — only new/edited work is done. Backs the
// "Process new chunks" button on /eval. Streams progress as NDJSON (one
// EvalEvent per line) so the dashboard can show a live bar + per-question results.
// ---------------------------------------------------------------------------
import { processNewChunks, type EvalEvent } from "@/lib/rag/eval";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";

export async function POST(request: Request) {
  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await processNewChunks(send);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Eval processing failed.";
        send({ type: "error", message });
      }
    }),
  );
}
