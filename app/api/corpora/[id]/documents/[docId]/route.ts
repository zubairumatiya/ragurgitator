// ---------------------------------------------------------------------------
// API route: DELETE /api/corpora/[id]/documents/[docId]
//
// Remove a document from a corpus. Membership only — the document stays global
// and other corpora keep it — EXCEPT configs auto-synced to this corpus, whose
// embedding of the doc (chunks, eval labels, overrides) is removed too; that's
// what sync means. Unsynced/detached configs are untouched. `params` is a
// Promise in this Next.js version.
// ---------------------------------------------------------------------------
import { getCorpus, removeDocumentFromCorpus } from "@/lib/rag/corpusStore";
import { syncRemoveDocFromConfigs } from "@/lib/rag/pipeline";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const { id, docId } = await params;
  try {
    const corpus = await getCorpus(id);
    if (!corpus) return Response.json({ error: "Corpus not found." }, { status: 404 });

    const removed = await removeDocumentFromCorpus(id, docId);
    if (!removed) {
      return Response.json({ error: "Document is not in this corpus." }, { status: 404 });
    }
    const removedFromConfigs = await syncRemoveDocFromConfigs(id, docId);
    return Response.json({ ok: true, removedFromConfigs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove document.";
    return Response.json({ error: message }, { status: 500 });
  }
}
