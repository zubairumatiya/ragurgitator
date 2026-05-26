// ---------------------------------------------------------------------------
// STEP 4 of ingestion: STORE  (and the backend for retrieval)
//
// Persists documents + chunks in Postgres (pgvector) and answers nearest-
// neighbor queries. Vectors live in one table per (embedding-model, dim) so
// different models stay in their own geometric spaces; see migrations/.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { config } from "@/lib/config";
import type { RetrievedChunk } from "@/types/rag";

export type IngestedDocument = {
  id: string;
  fileName: string;
  chunkCount: number;
  ingestedAt: number;
};

export type FoundDocument = { id: string; fileName: string };

// Add a case here (and a corresponding migration) when introducing a new
// embedding model or dimension. Refusing unknown combos here makes the
// missing migration obvious at runtime.
export function chunksTable(model: string, dimension: number): string {
  if (model === "voyage-4-lite" && dimension === 1024) {
    return "chunks_voyage_4_lite_1024";
  }
  throw new Error(
    `No chunks table for model="${model}" dim=${dimension}. Add a migration and update chunksTable().`,
  );
}

// pgvector parses the "[x,y,z]" text format and casts to vector via the
// destination column type, so we just send a string.
function vectorLiteral(v: number[]): string {
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
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into documents (file_name, content_hash)
    values (${fileName}, ${contentHash})
    returning id
  `;
  return rows[0].id;
}

export async function hasEmbeddingRun(
  documentId: string,
  model: string,
  chunkSize: number,
  chunkOverlap: number,
): Promise<boolean> {
  const rows = await sql`
    select 1
    from document_embeddings
    where document_id = ${documentId}
      and model = ${model}
      and chunk_size = ${chunkSize}
      and chunk_overlap = ${chunkOverlap}
    limit 1
  `;
  return rows.length > 0;
}

export type ChunkInsert = {
  position: number;
  text: string;
  embedding: number[];
};

export async function insertEmbeddingRunWithChunks(args: {
  documentId: string;
  model: string;
  dimension: number;
  chunkSize: number;
  chunkOverlap: number;
  chunks: ChunkInsert[];
}): Promise<void> {
  const table = chunksTable(args.model, args.dimension);

  await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into document_embeddings
        (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count)
      values
        (${args.documentId}, ${args.model}, ${args.dimension},
         ${args.chunkSize}, ${args.chunkOverlap}, ${args.chunks.length})
      returning id
    `;

    if (args.chunks.length === 0) return;

    const rows = args.chunks.map((c) => ({
      document_id: args.documentId,
      document_embedding_id: run.id,
      position: c.position,
      text: c.text,
      embedding: vectorLiteral(c.embedding),
    }));

    await tx`insert into ${tx(table)} ${tx(rows)}`;
  });
}

export async function query(
  vector: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  const table = chunksTable(config.embeddingModel, vector.length);
  const queryVec = vectorLiteral(vector);

  const rows = await sql<
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
    from ${sql(table)}
    order by embedding <=> ${queryVec}::vector
    limit ${topK}
  `;

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
    where de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
    order by de.created_at desc
  `;

  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    chunkCount: r.chunk_count,
    ingestedAt: r.created_at.getTime(),
  }));
}
