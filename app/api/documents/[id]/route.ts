// ---------------------------------------------------------------------------
// API route: DELETE /api/documents/[id]
//
// Removes a document and all data derived from it (chunks/embeddings + eval
// questions/labels/results) via FK cascade — see deleteDocument(). `params` is
// a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { deleteDocument } from "@/lib/rag/vectorStore";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const deleted = await deleteDocument(id);
    if (!deleted) {
      return Response.json({ error: "Document not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
