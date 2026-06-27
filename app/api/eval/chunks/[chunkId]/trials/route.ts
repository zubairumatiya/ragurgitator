// ---------------------------------------------------------------------------
// API route: /api/eval/chunks/[chunkId]/trials
//
// Lightweight read of a chunk's saved model trials, so the dashboard can show the
// "Models tried" list attached to the chunk without loading the full trial
// context (pool/corpus/models) the runner needs. `params` is a Promise in this
// Next.js version — await it.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { listModelTrials } from "@/lib/rag/evalStore";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const { chunkId } = await params;
  return withRequestConfig(request, async () => {
    try {
      const trials = await listModelTrials(chunkId);
      return Response.json({ trials });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load saved trials.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
