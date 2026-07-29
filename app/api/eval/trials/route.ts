// ---------------------------------------------------------------------------
// API route: GET /api/eval/trials
//
// Every saved model trial under the active config, grouped by source chunk id —
// the batched form of /api/eval/chunks/[chunkId]/trials. The dashboard shows a
// "Models tried" section per chunk group, so the per-chunk route meant one
// request per group (80 on the current corpus, most of them empty). The
// per-chunk route stays for the trial runner, which reads a single chunk.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { listModelTrialsByChunk } from "@/lib/rag/evalStore";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const trialsByChunk = await listModelTrialsByChunk();
      return Response.json({ trialsByChunk });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load saved trials.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
