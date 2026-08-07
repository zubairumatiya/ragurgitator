// ---------------------------------------------------------------------------
// API route: DELETE /api/documents/[id]
//
// Removes the ACTIVE CONFIG's embedding of a document — its chunks, the eval
// labels pointing at them, and its per-chunk overrides (see
// deleteEmbeddingRunFor). Scoped on purpose: the list this is called from (GET
// /api/documents) is per-config, so a delete on it has to be per-config too.
// Every other config keeps its own embedding, the eval questions stay (they are
// per-document by design, shared across configs), and the document itself stays
// in the user's library, re-embeddable with no re-upload.
//
// `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { deleteEmbeddingRunFor } from "@/lib/rag/vectorStore";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRequestConfig(request, async () => {
    try {
      const cfg = activeConfig();
      const deleted = await deleteEmbeddingRunFor(
        { id: cfg.id, chunksTable: cfg.chunksTable },
        id,
      );
      if (!deleted) {
        // No run under THIS config: either the id is wrong or another tab
        // deleted it. Same 404 either way — there is nothing here to remove.
        return Response.json(
          { error: "This config has no embedding of that document." },
          { status: 404 },
        );
      }
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
