// ---------------------------------------------------------------------------
// STEP 4 of ingestion: STORE  (and the backend for retrieval)
//
// Persists documents + chunks in Postgres (pgvector) and answers nearest-
// neighbor queries. Vectors live in one table per (embedding-model, dim) so
// different models stay in their own geometric spaces; see migrations/.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { modelSpec } from "@/lib/rag/embeddingModels";
import type { RetrievedChunk } from "@/types/rag";

// Filtered HNSW search needs a larger candidate list so enough rows survive the
// config_id predicate to fill the top-k once several configs share a chunk table
// (see docs/multi-config-plan.md §5.3). Harmless with a single config.
const EF_SEARCH = 100;

export type IngestedDocument = {
  id: string;
  fileName: string;
  chunkCount: number;
  ingestedAt: number;
};

export type FoundDocument = { id: string; fileName: string };

// Dimension of a model's embeddings, from the registry (lib/rag/embeddingModels).
export function modelDimension(model: string): number {
  return modelSpec(model).dimension;
}

// The physical chunks_<model>_<dim> table a config's vectors live in. Resolved
// from the registry, but only for INGESTABLE models — a model without
// `ingestable: true` (and thus no chunks_* migration) fails here, making the
// missing migration obvious at runtime. The derived name follows the migration
// convention: id dashes → underscores, then the dimension.
//   voyage-4-lite, 1024 -> chunks_voyage_4_lite_1024
export function chunksTable(model: string, dimension: number): string {
  const spec = modelSpec(model);
  if (!spec.ingestable) {
    throw new Error(
      `Model "${model}" is not ingestable — no chunks table. Set ingestable:true ` +
        `in EMBEDDING_MODELS and add a chunks_<model>_<dim> migration.`,
    );
  }
  if (dimension !== spec.dimension) {
    throw new Error(
      `Dimension mismatch for "${model}": asked for ${dimension}, registry says ${spec.dimension}.`,
    );
  }
  return `chunks_${model.replace(/-/g, "_")}_${dimension}`;
}

// pgvector parses the "[x,y,z]" text format and casts to vector via the
// destination column type, so we just send a string.
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function findDocumentByHash(
  contentHash: string,
): Promise<FoundDocument | null> {
  const rows = await sql<{ id: string; file_name: string }[]>`
    select id, file_name
    from documents
    where content_hash = ${contentHash}
    limit 1
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].id, fileName: rows[0].file_name };
}

export async function insertDocument(
  fileName: string,
  contentHash: string,
  content: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into documents (file_name, content_hash, content)
    values (${fileName}, ${contentHash}, ${content})
    returning id
  `;
  return rows[0].id;
}

// Delete a document and everything derived from it. The on-delete-cascade FKs
// (documents -> document_embeddings -> chunks, and -> eval_questions -> labels
// -> results) clear the vector AND eval data in one statement, across every
// config the doc was processed under. eval_runs are intentionally NOT cascaded:
// they're frozen aggregate snapshots kept for run-to-run comparison.
// Returns false when no row matched (already gone), so the route can 404.
export async function deleteDocument(id: string): Promise<boolean> {
  const rows = await sql`
    delete from documents
    where id = ${id}
    returning id
  `;
  return rows.length > 0;
}

// Remove ONE config's embedding of a document (corpus auto-sync removal): the
// document itself — and every other config's embedding of it — stays. Deleting
// the document_embeddings row cascades that config's chunk rows + eval_labels;
// config_chunk_overrides is cleaned explicitly first because source_chunk_id
// has no FK (chunks live in per-model tables). Returns false when the config
// never embedded the document.
export async function deleteEmbeddingRunFor(
  cfg: { id: string; chunksTable: string },
  documentId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`
      delete from config_chunk_overrides
      where config_id = ${cfg.id}
        and source_chunk_id in (
          select id from ${tx(cfg.chunksTable)}
          where config_id = ${cfg.id} and document_id = ${documentId}
        )
    `;
    const rows = await tx`
      delete from document_embeddings
      where config_id = ${cfg.id} and document_id = ${documentId}
      returning id
    `;
    return rows.length > 0;
  });
}

// Has this document already been embedded under the ACTIVE config? (config_id +
// document_id uniquely identify a run, given the config fixes model/size/overlap.)
export async function hasEmbeddingRun(documentId: string): Promise<boolean> {
  const cfg = activeConfig();
  const rows = await sql`
    select 1
    from document_embeddings
    where config_id = ${cfg.id}
      and document_id = ${documentId}
    limit 1
  `;
  return rows.length > 0;
}

export type ChunkInsert = {
  position: number;
  text: string;
  embedding: number[];
};

// Persist one embedding run + its chunks under the ACTIVE config. Model,
// dimension, chunk size/overlap and the physical table all come from the config,
// so the caller only supplies the document and its chunks.
export async function insertEmbeddingRunWithChunks(args: {
  documentId: string;
  chunks: ChunkInsert[];
}): Promise<void> {
  const cfg = activeConfig();

  await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into document_embeddings
        (config_id, document_id, model, dimension, chunk_size, chunk_overlap, chunk_count)
      values
        (${cfg.id}, ${args.documentId}, ${cfg.embeddingModel}, ${cfg.dimension},
         ${cfg.chunkSize}, ${cfg.chunkOverlap}, ${args.chunks.length})
      returning id
    `;

    if (args.chunks.length === 0) return;

    const rows = args.chunks.map((c) => ({
      config_id: cfg.id,
      document_id: args.documentId,
      document_embedding_id: run.id,
      position: c.position,
      text: c.text,
      embedding: vectorLiteral(c.embedding),
    }));

    await tx`insert into ${tx(cfg.chunksTable)} ${tx(rows)}`;
  });
}

export async function query(
  vector: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  const cfg = activeConfig();
  const queryVec = vectorLiteral(vector);

  // Config-filtered ANN: only this config's chunks compete. Raise ef_search
  // inside the txn so the filter doesn't starve the top-k once multiple configs
  // share the table (§5.3). EF_SEARCH is a trusted constant, hence unsafe().
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.ef_search = ${EF_SEARCH}`);
    return tx<
      {
        id: string;
        document_id: string;
        position: number;
        text: string;
        score: number;
      }[]
    >`
      select
        id,
        document_id,
        position,
        text,
        1 - (embedding <=> ${queryVec}::vector) as score
      from ${tx(cfg.chunksTable)}
      where config_id = ${cfg.id}
      order by embedding <=> ${queryVec}::vector
      limit ${topK}
    `;
  });

  return rows.map((r) => ({
    score: Number(r.score),
    chunk: {
      embedding: [],
      chunk: {
        id: r.id,
        documentId: r.document_id,
        text: r.text,
        position: r.position,
      },
    },
  }));
}

// Like query(), but excludes a set of chunk ids from the active config's base
// ANN — the chunks that have been overridden to a different model (Phase 5).
// Those are ranked separately in their override model's space and RRF-fused with
// this list (see retriever.retrieveForQuery). An empty exclude list behaves like
// query(). Pulls `limit` candidates (callers pass a generous N for fusion).
export async function queryExcluding(
  vector: number[],
  limit: number,
  excludeIds: string[],
): Promise<RetrievedChunk[]> {
  const cfg = activeConfig();
  const queryVec = vectorLiteral(vector);

  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.ef_search = ${EF_SEARCH}`);
    return tx<
      { id: string; document_id: string; position: number; text: string; score: number }[]
    >`
      select
        id, document_id, position, text,
        1 - (embedding <=> ${queryVec}::vector) as score
      from ${tx(cfg.chunksTable)}
      where config_id = ${cfg.id}
        and not (id = any(${excludeIds}::uuid[]))
      order by embedding <=> ${queryVec}::vector
      limit ${limit}
    `;
  });

  return rows.map((r) => ({
    score: Number(r.score),
    chunk: {
      embedding: [],
      chunk: { id: r.id, documentId: r.document_id, text: r.text, position: r.position },
    },
  }));
}

// Resolve a set of chunk ids (in the active config's base table) to their text +
// position + document. Used to flesh out override chunks that won RRF but weren't
// in the base ANN result (they were excluded from it).
export async function resolveChunks(
  ids: string[],
): Promise<Map<string, { documentId: string; position: number; text: string }>> {
  if (ids.length === 0) return new Map();
  const cfg = activeConfig();
  const rows = await sql<
    { id: string; document_id: string; position: number; text: string }[]
  >`
    select id, document_id, position, text
    from ${sql(cfg.chunksTable)}
    where config_id = ${cfg.id}
      and id = any(${ids}::uuid[])
  `;
  return new Map(
    rows.map((r) => [r.id, { documentId: r.document_id, position: r.position, text: r.text }]),
  );
}

// One row in the user's LIBRARY: a previously-uploaded document (with stored
// raw text) that the ACTIVE config hasn't embedded yet — the pick-list for
// "ingest without re-uploading".
export type LibraryDocument = {
  id: string;
  fileName: string;
  uploadedAt: number;
};

export async function listLibraryDocuments(): Promise<LibraryDocument[]> {
  const cfg = activeConfig();
  const rows = await sql<{ id: string; file_name: string; created_at: Date }[]>`
    select d.id, d.file_name, d.created_at
    from documents d
    where d.content is not null
      and not exists (
        select 1 from document_embeddings de
        where de.document_id = d.id and de.config_id = ${cfg.id}
      )
    order by d.created_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    uploadedAt: r.created_at.getTime(),
  }));
}

export async function listDocuments(): Promise<IngestedDocument[]> {
  const rows = await sql<
    {
      id: string;
      file_name: string;
      chunk_count: number;
      created_at: Date;
    }[]
  >`
    select
      d.id,
      d.file_name,
      de.chunk_count,
      de.created_at
    from document_embeddings de
    join documents d on d.id = de.document_id
    where de.config_id = ${activeConfig().id}
    order by de.created_at desc
  `;

  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    chunkCount: r.chunk_count,
    ingestedAt: r.created_at.getTime(),
  }));
}
