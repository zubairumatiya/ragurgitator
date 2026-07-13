// ---------------------------------------------------------------------------
// API route: GET /api/eval/cached-chunks?model=<id>
//
// Chunk ids under the active config whose text already has a cached 'document'
// embedding under `model` (0020). The "Try a different configuration" panel
// auto-adds these to the trial's test pool — they cost nothing to include
// (delegate-space retrieval / earlier trials already embedded them), and a
// wider pool keeps trials honest about the live competition.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { cachedChunkIdsForModel } from "@/lib/rag/evalStore";

export async function GET(request: Request) {
  const model = new URL(request.url).searchParams.get("model");
  if (!model) {
    return Response.json({ error: "Provide a `model` query param." }, { status: 400 });
  }
  return withRequestConfig(request, async () => {
    try {
      const chunkIds = await cachedChunkIdsForModel(model);
      return Response.json({ chunkIds });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to list cached chunks.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
