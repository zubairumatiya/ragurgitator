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

export async function POST() {
  return ndjsonStream<EvalEvent>(async (send) => {
    try {
      await processNewChunks(send);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Eval processing failed.";
      send({ type: "error", message });
    }
  });
}
