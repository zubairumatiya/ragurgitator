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

export type CorpusSummary = {
  id: string;
  name: string;
  docCount: number;
  // Documents whose raw text is stored, so they can be re-chunked/re-embedded
  // into a new config WITHOUT re-upload. Docs ingested before raw text was kept
  // (migration 0010) have content = null and can't be re-embedded — surfaced so
  // the corpus picker can warn before a spawn yields an empty config.
  embeddableCount: number;
  createdAt: number;
};

// All corpora with their document counts, for the config-creation corpus picker.
export async function listCorpora(): Promise<CorpusSummary[]> {
  const rows = await sql<
    { id: string; name: string; doc_count: number; embeddable_count: number; created_at: Date }[]
  >`
    select
      co.id,
      co.name,
      count(cd.document_id)::int as doc_count,
      count(cd.document_id) filter (where d.content is not null)::int as embeddable_count,
      co.created_at
    from corpora co
    left join corpus_documents cd on cd.corpus_id = co.id
    left join documents d on d.id = cd.document_id
    group by co.id, co.name, co.created_at
    order by co.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    docCount: r.doc_count,
    embeddableCount: r.embeddable_count,
    createdAt: r.created_at.getTime(),
  }));
}

export type EmbeddableDoc = { id: string; fileName: string; content: string };

// A corpus's documents that have stored raw text, for re-embedding into a new
// config (the spawn-from-corpus flow). Docs without content are omitted — the
// caller reports them as skipped.
export async function corpusDocumentsForEmbedding(
  corpusId: string,
): Promise<EmbeddableDoc[]> {
  const rows = await sql<{ id: string; file_name: string; content: string }[]>`
    select d.id, d.file_name, d.content
    from corpus_documents cd
    join documents d on d.id = cd.document_id
    where cd.corpus_id = ${corpusId}
      and d.content is not null
    order by d.created_at
  `;
  return rows.map((r) => ({ id: r.id, fileName: r.file_name, content: r.content }));
}
