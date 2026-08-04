// ---------------------------------------------------------------------------
// API route: POST /api/eval/autotune
//
// Runs the Phase C autotune engine: for every question below its min-rate,
// search chunk sizes / models / combos, persist winning per-chunk overrides
// (confirmed via real retrieval), then one full-corpus re-score + snapshot.
// Streams progress as NDJSON (one AutotuneEvent per line) so the dashboard can
// show live per-chunk progress and collect pending choices.
// ---------------------------------------------------------------------------
import { runAutotune, type AutotuneEvent } from "@/lib/rag/autotune";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";

export async function POST(request: Request) {
  // Timing-trial grouping (0041): scripts/autotune-trial.ts labels its runs so
  // the Appraise → Trial times tab can median them together. Header rather than
  // body — the body is unused here and the header survives the stream wrapper.
  const trialLabel = request.headers.get("x-trial-label");
  return withRequestConfig(request, async () =>
    ndjsonStream<AutotuneEvent>(async (send) => {
      try {
        await runAutotune(send, { trialLabel });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Autotune failed.";
        send({ type: "error", message });
      }
    }),
  );
}
