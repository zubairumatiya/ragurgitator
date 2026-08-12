// API route: GET /api/eval/chunks/[chunkId]
//
// One chunk's text, for the dashboard's "chunk #N" toggle. Deliberately not part
// of the eval summary: the summary carries a ChunkRef for every chunk under the
// config, and folding each one's text into that payload would grow it by the
// size of the whole corpus to serve a panel the user opens on one chunk at a
// time.
//
// A missing chunk and a chunk under a different config both answer 404 — see
// getChunkText. `params` is a Promise in this Next.js version — await it.
import { withRequestConfig } from "@/lib/http/configScope";
import { getChunkText } from "@/lib/rag/evalStore";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const { chunkId } = await params;
  return withRequestConfig(request, async () => {
    try {
      const chunk = await getChunkText(chunkId);
      if (!chunk) {
        return Response.json({ error: "Chunk not found." }, { status: 404 });
      }
      return Response.json(chunk);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load chunk.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
