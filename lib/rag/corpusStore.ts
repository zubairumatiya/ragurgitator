// ---------------------------------------------------------------------------
// DB layer for corpora (reusable named document sets) — see migrations/0010 and
// docs/multi-config-plan.md. Raw SQL via the shared `sql` client, no business
// logic. Mirrors vectorStore.ts / evalStore.ts.
//
// Phase 1 only needs membership writes during ingestion (a document ingested
// under the active config joins that config's corpus). Corpus CRUD + the
// "remove from this corpus" deletion semantics (D9) land with corpus management
// in Phase 3.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";

// Create a new, empty corpus and return its id. Phase 2's "+ New config" makes a
// fresh corpus per config so the new tab starts blank; the rest of corpus CRUD
// (rename/list/membership management) lands with the corpus UI in Phase 3.
export async function createCorpus(name: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into corpora (name)
    values (${name})
    returning id
  `;
  return rows[0].id;
}

// Add a document to a corpus. Idempotent: re-adding the same document is a no-op,
// so re-ingesting a file that's already a member doesn't error.
export async function addDocumentToCorpus(
  corpusId: string,
  documentId: string,
): Promise<void> {
  await sql`
    insert into corpus_documents (corpus_id, document_id)
    values (${corpusId}, ${documentId})
    on conflict (corpus_id, document_id) do nothing
  `;
}
