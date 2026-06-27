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
