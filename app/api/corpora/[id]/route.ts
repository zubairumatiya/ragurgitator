// ---------------------------------------------------------------------------
// API route: GET/DELETE /api/corpora/[id]
//
// GET returns everything the corpus detail page (and the create-config dialog's
// duplicate detection) needs in one shot: the corpus, its member documents
// (with content hashes), the configs attached to it (synced or not), and the
// global documents NOT yet in it (the "add existing document" picker).
//
// DELETE removes the corpus. Configs attached to it survive — the 0017 FK
// clears their corpus_id, so auto-sync simply breaks; their embedded documents
// are untouched. Global (not config-scoped). `params` is a Promise in this
// Next.js version.
// ---------------------------------------------------------------------------
import {
  deleteCorpus,
  getCorpus,
  listCorpusConfigs,
  listCorpusDocuments,
  listDocumentsNotInCorpus,
} from "@/lib/rag/corpusStore";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const corpus = await getCorpus(id);
    if (!corpus) return Response.json({ error: "Corpus not found." }, { status: 404 });
    const [documents, configs, availableDocuments] = await Promise.all([
      listCorpusDocuments(id),
      listCorpusConfigs(id),
      listDocumentsNotInCorpus(id),
    ]);
    return Response.json({ corpus, documents, configs, availableDocuments });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load corpus.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const corpus = await getCorpus(id);
    if (!corpus) return Response.json({ error: "Corpus not found." }, { status: 404 });
    const detached = await listCorpusConfigs(id);
    await deleteCorpus(id);
    // Report which configs lost their pointer so the UI can say so.
    return Response.json({ ok: true, detachedConfigs: detached.map((c) => c.label) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete corpus.";
    return Response.json({ error: message }, { status: 500 });
  }
}
