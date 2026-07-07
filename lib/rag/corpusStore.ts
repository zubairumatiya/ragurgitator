// ---------------------------------------------------------------------------
// DB layer for corpora (reusable named document sets) — see migrations/0010,
// 0017 and docs/multi-config-plan.md. Raw SQL via the shared `sql` client, no
// business logic. Mirrors vectorStore.ts / evalStore.ts.
//
// Since 0017 corpora are DECOUPLED from configs: a corpus is a quick way to
// select a document set; a config's actual documents are its own embedding
// runs. A config may point at a corpus (configs.corpus_id, nullable) and opt
// into auto-sync (configs.corpus_sync) so membership changes flow both ways.
// Deleting a corpus never touches configs — the FK sets their pointer null.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { isUuid } from "@/lib/rag/activeConfig";

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
  // How many configs (open or closed) point at this corpus — shown on the
  // corpora page so it's clear which corpora are in active use.
  configCount: number;
  createdAt: number;
};

// Corpora with their document counts, for the config-creation corpus picker,
// the sidebar, and the corpora page.
//
// `includeEmpty` (default false) keeps doc-less corpora out: deleting a config
// leaves its corpus behind by design (D9), so empty orphans would otherwise
// pile up as useless entries. The corpora page/sidebar pass true so a corpus
// the user just created (deliberately empty, to be filled via a config's
// uploads) is visible — and the picker passes true too, so such a corpus can
// actually be attached to a new config.
export async function listCorpora(
  opts: { includeEmpty?: boolean } = {},
): Promise<CorpusSummary[]> {
  const includeEmpty = opts.includeEmpty ?? false;
  const rows = await sql<
    {
      id: string;
      name: string;
      doc_count: number;
      embeddable_count: number;
      config_count: number;
      created_at: Date;
    }[]
  >`
    select
      co.id,
      co.name,
      count(cd.document_id)::int as doc_count,
      count(cd.document_id) filter (where d.content is not null)::int as embeddable_count,
      (select count(*)::int from configs cf where cf.corpus_id = co.id) as config_count,
      co.created_at
    from corpora co
    left join corpus_documents cd on cd.corpus_id = co.id
    left join documents d on d.id = cd.document_id
    group by co.id, co.name, co.created_at
    having (count(cd.document_id) > 0 or ${includeEmpty})
    order by co.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    docCount: r.doc_count,
    embeddableCount: r.embeddable_count,
    configCount: r.config_count,
    createdAt: r.created_at.getTime(),
  }));
}

// One corpus by id (null for a malformed/unknown id, so pages can 404 cleanly).
export type Corpus = { id: string; name: string; createdAt: number };

export async function getCorpus(id: string): Promise<Corpus | null> {
  if (!isUuid(id)) return null;
  const rows = await sql<{ id: string; name: string; created_at: Date }[]>`
    select id, name, created_at from corpora where id = ${id} limit 1
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at.getTime() };
}

// A corpus's member documents, for the corpus detail page and the dedup logic.
// `hasContent` = raw text is stored (docs ingested before migration 0010 have
// none and can't be re-embedded into a config). `contentHash` lets callers
// detect duplicate uploads that live as separate document rows.
export type CorpusDocument = {
  id: string;
  fileName: string;
  contentHash: string;
  hasContent: boolean;
  addedAt: number;
};

export async function listCorpusDocuments(corpusId: string): Promise<CorpusDocument[]> {
  const rows = await sql<
    { id: string; file_name: string; content_hash: string; has_content: boolean; added_at: Date }[]
  >`
    select d.id, d.file_name, d.content_hash, (d.content is not null) as has_content,
           cd.added_at
    from corpus_documents cd
    join documents d on d.id = cd.document_id
    where cd.corpus_id = ${corpusId}
    order by cd.added_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    contentHash: r.content_hash,
    hasContent: r.has_content,
    addedAt: r.added_at.getTime(),
  }));
}

// Documents NOT in this corpus — the detail page's "add existing document"
// picker (documents are global; any of them can join any corpus).
export async function listDocumentsNotInCorpus(corpusId: string): Promise<CorpusDocument[]> {
  const rows = await sql<
    { id: string; file_name: string; content_hash: string; has_content: boolean; created_at: Date }[]
  >`
    select d.id, d.file_name, d.content_hash, (d.content is not null) as has_content,
           d.created_at
    from documents d
    where not exists (
      select 1 from corpus_documents cd
      where cd.corpus_id = ${corpusId} and cd.document_id = d.id
    )
    order by d.created_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    contentHash: r.content_hash,
    hasContent: r.has_content,
    addedAt: r.created_at.getTime(),
  }));
}

// Remove a document from a corpus (membership only — the document itself, and
// any config that embedded it, are untouched; the sync layer handles removing
// it from auto-synced configs). Returns false when it wasn't a member.
export async function removeDocumentFromCorpus(
  corpusId: string,
  documentId: string,
): Promise<boolean> {
  const rows = await sql`
    delete from corpus_documents
    where corpus_id = ${corpusId} and document_id = ${documentId}
    returning document_id
  `;
  return rows.length > 0;
}

// Delete a corpus. Memberships cascade; configs pointing at it get corpus_id
// NULL via the 0017 FK — auto-sync simply breaks, the configs and their
// embedded documents remain. Returns false when no row matched.
export async function deleteCorpus(id: string): Promise<boolean> {
  const rows = await sql`
    delete from corpora where id = ${id} returning id
  `;
  return rows.length > 0;
}

// Configs attached to this corpus (corpus_id pointer), for the detail page's
// "synced configs" header. `corpusSync` distinguishes live auto-sync from a
// mere pointer (sync toggled off).
export type CorpusConfig = {
  id: string;
  label: string;
  corpusSync: boolean;
  isOpen: boolean;
};

export async function listCorpusConfigs(corpusId: string): Promise<CorpusConfig[]> {
  const rows = await sql<
    {
      id: string;
      name: string | null;
      base_model: string;
      chunk_size: number;
      chunk_overlap: number;
      corpus_sync: boolean;
      is_open: boolean;
    }[]
  >`
    select id, name, base_model, chunk_size, chunk_overlap, corpus_sync, is_open
    from configs
    where corpus_id = ${corpusId}
    order by created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    label: r.name ?? `${r.base_model} · ${r.chunk_size}/${r.chunk_overlap}`,
    corpusSync: r.corpus_sync,
    isOpen: r.is_open,
  }));
}

// The union of several corpora's documents, de-duplicated by content hash —
// the same file uploaded twice is two `documents` rows with one hash; a config
// (or merged corpus) built from overlapping corpora should embed it once. The
// kept row per hash prefers stored raw text (re-embeddable), then age. `dupes`
// reports what was collapsed so the UI can warn ("duplicate docs detected").
export type DedupedSelection = {
  docs: CorpusDocument[];
  dupes: { contentHash: string; kept: string; dropped: string[] }[]; // file names
};

export async function dedupCorporaDocuments(corpusIds: string[]): Promise<DedupedSelection> {
  if (corpusIds.length === 0) return { docs: [], dupes: [] };
  const rows = await sql<
    { id: string; file_name: string; content_hash: string; has_content: boolean; created_at: Date }[]
  >`
    select distinct on (d.id)
           d.id, d.file_name, d.content_hash, (d.content is not null) as has_content,
           d.created_at
    from corpus_documents cd
    join documents d on d.id = cd.document_id
    where cd.corpus_id = any(${corpusIds}::uuid[])
    order by d.id
  `;
  type DocRow = {
    id: string;
    file_name: string;
    content_hash: string;
    has_content: boolean;
    created_at: Date;
  };
  const byHash = new Map<string, DocRow[]>();
  for (const r of rows) {
    const group = byHash.get(r.content_hash) ?? [];
    group.push(r);
    byHash.set(r.content_hash, group);
  }
  const docs: CorpusDocument[] = [];
  const dupes: DedupedSelection["dupes"] = [];
  for (const [hash, group] of byHash) {
    group.sort(
      (a, b) =>
        Number(b.has_content) - Number(a.has_content) ||
        a.created_at.getTime() - b.created_at.getTime(),
    );
    const [keep, ...rest] = group;
    docs.push({
      id: keep.id,
      fileName: keep.file_name,
      contentHash: keep.content_hash,
      hasContent: keep.has_content,
      addedAt: keep.created_at.getTime(),
    });
    if (rest.length > 0) {
      dupes.push({
        contentHash: hash,
        kept: keep.file_name,
        dropped: rest.map((r) => r.file_name),
      });
    }
  }
  docs.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { docs, dupes };
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

// Arbitrary documents (by id) with stored raw text, for embedding a de-duped
// multi-corpus selection or sync-embedding corpus additions into a config.
export async function documentsForEmbedding(docIds: string[]): Promise<EmbeddableDoc[]> {
  if (docIds.length === 0) return [];
  const rows = await sql<{ id: string; file_name: string; content: string }[]>`
    select d.id, d.file_name, d.content
    from documents d
    where d.id = any(${docIds}::uuid[])
      and d.content is not null
    order by d.created_at
  `;
  return rows.map((r) => ({ id: r.id, fileName: r.file_name, content: r.content }));
}
