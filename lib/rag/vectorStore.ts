// STEP 4 of ingestion: STORE  (and the backend for retrieval)
//
// Persists documents + chunks in Postgres (pgvector) and answers nearest-
// neighbor queries. Vectors live in one table per (embedding-model, dim) so
// different models stay in their own geometric spaces; see migrations/.
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { modelSpec } from "@/lib/rag/embeddingModels";
import type { RetrievedChunk } from "@/types/rag";

// Filtered HNSW search needs a larger candidate list so enough rows survive the
// config_id predicate to fill the top-k once several configs share a chunk table
// (see docs/multi-config-plan.md §5.3). Harmless with a single config.
//
// Exported so every config-filtered ANN in the app searches at the SAME depth —
// the graded-nDCG candidate pool (rankingStore.poolNearest) runs the identical
// pattern outside this module, and two different ef_search values would make the
// ideal ranking and live retrieval disagree about what the neighbourhood is.
export const EF_SEARCH = 100;

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
  // Scoped to the owner, which is the whole point of 0049's per-user unique key
  // on (user_id, content_hash): dedup must not reach across accounts, or the
  // second uploader silently adopts the first's document — and learns the file
  // already exists somewhere on the system.
  const rows = await sql<{ id: string; file_name: string }[]>`
    select id, file_name
    from documents
    where content_hash = ${contentHash}
      and user_id = ${activeUserId()}
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
    insert into documents (user_id, file_name, content_hash, content)
    values (${activeUserId()}, ${fileName}, ${contentHash}, ${content})
    returning id
  `;
  return rows[0].id;
}

// NOTE — deleteDocument USED TO LIVE HERE, and DELETE /api/documents/[id] called
// it. One statement deleted the `documents` row and let the FK cascade take the
// embeddings, chunks, eval questions/labels/results with it — ACROSS EVERY CONFIG,
// which is not what a delete on one config's document list should mean. That route
// now calls deleteEmbeddingRunFor, so a delete is scoped to the config you
// performed it in.
//
// Nothing in the app purges a `documents` row any more. The row and its stored text
// survive as a library entry, re-embeddable without a re-upload; they are reachable
// only by "delete my account".

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

// Which of `documentIds` the ACTIVE config already has a run for, and how big each
// one is. Absent from the map = not embedded here.
//
// The chunk count comes off document_embeddings rather than counting chunk rows, so
// this is a point-read per document however large the run is. Callers use it to
// tell "this document was already here" from "this document's run landed during the
// operation I'm reporting on" — which matters because the batch builder can write a
// complete run out of the embedding cache before the inline path ever looks, and
// reporting that as "no new chunks" describes work that did happen as work that
// didn't.
export async function embeddingRunChunkCounts(
  documentIds: string[],
): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await sql<{ document_id: string; chunk_count: number }[]>`
    select document_id, chunk_count
    from document_embeddings
    where config_id = ${activeConfig().id}
      and document_id = any(${documentIds}::uuid[])
  `;
  return new Map(rows.map((r) => [r.document_id, r.chunk_count]));
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

// The settings a run is LABELLED with. Supplied only when the caller produced
// its vectors under settings that may no longer match the live config — the
// async batch path, whose vectors are generated hours before they're written
// (see lib/batch/jobs/ingestEmbedding.ts). The config still selects the run's
// config_id; these override only what the vectors were actually made with.
export type EmbeddingRunSettings = {
  embeddingModel: string;
  dimension: number;
  chunkSize: number;
  chunkOverlap: number;
};

// Persist one embedding run + its chunks under the ACTIVE config. Model,
// dimension, chunk size/overlap and the physical table all come from the config,
// so the caller only supplies the document and its chunks. Returns the new chunk
// ids so the caller can top them into saved cluster presets (clusterStore
// .topUpSavedRuns) — done by the caller, not here, because re-chunking an
// existing config must NOT top up (see the note on that function).
//
// `settings` overrides those four labels (and the physical table, which is
// derived from model+dimension). Omit it for today's behavior.
export async function insertEmbeddingRunWithChunks(args: {
  documentId: string;
  chunks: ChunkInsert[];
  settings?: EmbeddingRunSettings;
}): Promise<string[]> {
  const cfg = activeConfig();
  const model = args.settings?.embeddingModel ?? cfg.embeddingModel;
  const dimension = args.settings?.dimension ?? cfg.dimension;
  const chunkSize = args.settings?.chunkSize ?? cfg.chunkSize;
  const chunkOverlap = args.settings?.chunkOverlap ?? cfg.chunkOverlap;
  // Vectors must land in the table for the space they were PRODUCED in, so the
  // table follows the overridden model/dimension rather than the live config.
  const table = args.settings ? chunksTable(model, dimension) : cfg.chunksTable;

  return await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into document_embeddings
        (config_id, document_id, model, dimension, chunk_size, chunk_overlap, chunk_count)
      values
        (${cfg.id}, ${args.documentId}, ${model}, ${dimension},
         ${chunkSize}, ${chunkOverlap}, ${args.chunks.length})
      returning id
    `;

    if (args.chunks.length === 0) return [];

    const rows = args.chunks.map((c) => ({
      config_id: cfg.id,
      document_id: args.documentId,
      document_embedding_id: run.id,
      position: c.position,
      text: c.text,
      embedding: vectorLiteral(c.embedding),
    }));

    const inserted = await tx<{ id: string }[]>`
      insert into ${tx(table)} ${tx(rows)} returning id
    `;
    return inserted.map((r) => r.id);
  });
}

// NOTE — reuseEmbeddingRun USED TO LIVE HERE. It copied a sibling config's run with
// one INSERT … SELECT when that config had embedded the same document under
// identical settings. Routing ingest through embedding_cache covers every case it
// covered and the one it could not — no sibling run survives, because the document
// was deleted — and books the saving under embed_cache rather than a second
// structural lever describing the same idea.
//
// What we gave up, stated honestly: the copy never took the vectors out of the
// database, where the cache route pulls them over the wire and rehashes the texts.
// Slower, still free.

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
// Those are ranked separately in their override model's space and rank-fused with
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

// queryExcluding without the `text` column — the deep fusion pool
// (docs/fusion-egress-plan.md §1.2). The merge only ever reads `score` and `id`
// off these rows; text is needed for the topK that SURVIVE, and those are
// resolved by id through resolveChunks. Pulling text on all deepN rows shipped
// ~480 kB a query to compute a rank.
//
// Returns the same RetrievedChunk shape so the caller (and its ANN cache) needs
// no second type — but `text`/`documentId`/`position` are EMPTY, not merely
// unread. A caller that needs them must resolve, and must not seed a `meta` map
// from these rows.
export async function queryExcludingIds(
  vector: number[],
  limit: number,
  excludeIds: string[],
): Promise<RetrievedChunk[]> {
  const cfg = activeConfig();
  const queryVec = vectorLiteral(vector);

  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.ef_search = ${EF_SEARCH}`);
    return tx<{ id: string; score: number }[]>`
      select
        id,
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
      chunk: { id: r.id, documentId: "", text: "", position: 0 },
    },
  }));
}

// One pooled candidate's competitor sim under a FOREIGN override model, computed
// in Postgres (docs/demo-egress-plan.md §1.2).
//
//   msim      the candidate's cosine against the override model's query vector,
//             read out of embedding_cache — or null when this user has never
//             banked that text under that model.
//   textHash  sha256 of the chunk text, the cache's content address. On the wire
//             because a null msim still has to be offerable to the optional DISK
//             layer, which answers by hash and is consulted BEFORE the database
//             (embedCache.readPersisted) — without it, turning EMBED_DISK_CACHE on
//             would start costing embeds.
//   textLen   character count, so a cache hit can still be PRICED as an avoided
//             embed without shipping the text it would have embedded (pricing
//             .estimateTokensFromChars exists for exactly this).
export type PoolDocSim = {
  id: string;
  textHash: string;
  textLen: number;
  msim: number | null;
};

// Competitor sims for an ALREADY-CHOSEN pool of chunk ids, under `model`.
//
// Keyed by id rather than re-running the ANN: the pool these sims describe must
// be the SAME multiset the base lane produced, or the fusion candidate set moves
// and the merged ranks move with it. Two ANN searches with identical arguments
// would almost certainly agree, but "almost certainly" is not the standard a
// no-FUSION_VERSION-bump change is held to (§4 D2), and this form also skips a
// second HNSW descent per override model per query.
//
// Replaces ~12 kB of vector per candidate (cachedDocVectors) with ~140 B of row.
// The cosine is pgvector's, against a float4 rendering of the query vector — the
// same arithmetic overrideStore.overrideSims already does, and measured against
// the JS path at ~1e-7 (scripts/fusion-equiv.ts).
export async function poolDocSims(
  ids: string[],
  model: string,
  modelVector: number[],
): Promise<Map<string, PoolDocSim>> {
  if (ids.length === 0) return new Map();
  const cfg = activeConfig();
  const userId = activeUserId();
  const modelVec = vectorLiteral(modelVector);

  // The projection's shape is load-bearing for scripts/egress-meter.ts's
  // `pool_sims` pattern, which anchors on `select p.id,` and the `text_hash` /
  // `msim` aliases — pg_stat_statements parameterises every literal, so the
  // aliases are the only stable thing to match on.
  const rows = await sql<
    { id: string; text_hash: string; text_len: number; msim: string | null }[]
  >`
    select
      p.id,
      p.text_hash as text_hash,
      p.text_len as text_len,
      1 - (ec.embedding::vector <=> ${modelVec}::vector) as msim
    from (
      select id,
             encode(sha256(text::bytea), 'hex') as text_hash,
             char_length(text) as text_len
      from ${sql(cfg.chunksTable)}
      where config_id = ${cfg.id}
        and id = any(${ids}::uuid[])
    ) p
    left join embedding_cache ec
      on ec.user_id = ${userId}
     and ec.model = ${model}
     and ec.input_kind = 'document'
     and ec.text_hash = p.text_hash
  `;

  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        textHash: r.text_hash,
        textLen: Number(r.text_len),
        msim: r.msim === null ? null : Number(r.msim),
      },
    ]),
  );
}

// Base-space embeddings for a set of chunk ids in the active config — for
// similarity screens that need a chunk's own stored vector rather than an ANN
// (eval.rescoreAffectedQuestions). pgvector's text form '[1,2,3]' is valid
// JSON, so read ::text and parse.
export async function chunkEmbeddings(ids: string[]): Promise<Map<string, number[]>> {
  if (ids.length === 0) return new Map();
  const cfg = activeConfig();
  const rows = await sql<{ id: string; vec: string }[]>`
    select id, embedding::text as vec
    from ${sql(cfg.chunksTable)}
    where config_id = ${cfg.id}
      and id = any(${ids}::uuid[])
  `;
  return new Map(rows.map((r) => [r.id, JSON.parse(r.vec) as number[]]));
}

// Resolve a set of chunk ids (in the active config's base table) to their text +
// position + document. Used to flesh out override chunks that won the merge but weren't
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
      and d.user_id = ${activeUserId()}
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

// File names for a handful of document ids — what the chat's source cards need
// to say "notes.pdf · chunk #3" instead of echoing a UUID. A RetrievedChunk
// carries only documentId (it is the retriever's row shape, shared with eval,
// and widening it for one label would push the join into every caller), so the
// lookup happens once per response over the ids actually returned.
//
// Owner-scoped, not config-scoped: the semantic cache replays stored sources
// whose chunks may predate the current config's embedding run, and a name is
// not worth suppressing over that.
export async function documentFileNames(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  const rows = await sql<{ id: string; file_name: string }[]>`
    select id, file_name from documents
    where id in ${sql(unique)} and user_id = ${activeUserId()}
  `;
  return Object.fromEntries(rows.map((r) => [r.id, r.file_name]));
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
