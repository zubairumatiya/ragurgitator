// ---------------------------------------------------------------------------
// DB layer for per-question graded nDCG rankings (migrations/0009). Raw SQL via
// the shared `sql` client, no business logic — orchestration lives in ranking.ts.
//
// Everything is scoped to the ACTIVE config (config.embeddingModel + chunkSize +
// chunkOverlap), like evalStore.ts / clusterStore.ts. A ranking is tied to the
// question's active-config embedding run (document_embedding_id), so changing the
// config makes a question's rankings stop matching and it reads ungraded again.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { config } from "@/lib/config";
import { chunksTable, vectorLiteral } from "@/lib/rag/vectorStore";

export type RankingKind = "aggregate" | "llm_pool" | "llm_rerank" | "manual";

export type StoredRanking = {
  id: string;
  kind: RankingKind;
  isTruth: boolean;
  chunkIds: string[]; // ideal order, best-first
  details: Record<string, unknown>;
  createdAt: number;
};

export type NearestBucket = {
  clusterId: string;
  ordinal: number;
  similarity: number; // cosine sim of the question to the bucket centroid
};

export type PoolCandidate = {
  chunkId: string;
  fileName: string;
  position: number | null;
  text: string;
  similarity: number; // cosine sim to the question under the active model
};

// Resolve the chunks table for the active config. Null when nothing is ingested
// under this config yet. (Same probe as evalStore/clusterStore.)
async function activeChunksTable(): Promise<string | null> {
  const rows = await sql<{ dimension: number }[]>`
    select dimension
    from document_embeddings
    where model = ${config.embeddingModel}
      and chunk_size = ${config.chunkSize}
      and chunk_overlap = ${config.chunkOverlap}
    limit 1
  `;
  if (rows.length === 0) return null;
  return chunksTable(config.embeddingModel, rows[0].dimension);
}

export type QuestionScope = {
  documentEmbeddingId: string; // active-config embedding run a ranking is filed under
  question: string; // the question text — embedded + sent to the LLM ranker
};

// The question's text + the active-config embedding run its ground-truth label
// uses (the scope a ranking is filed under). Null when the question has no label
// under the active config (stale id / wrong config).
export async function getQuestionScope(
  questionId: string,
): Promise<QuestionScope | null> {
  const [row] = await sql<{ document_embedding_id: string; question: string }[]>`
    select l.document_embedding_id, q.question
    from eval_labels l
    join eval_questions q on q.id = l.eval_question_id
    join document_embeddings de on de.id = l.document_embedding_id
    where l.eval_question_id = ${questionId}
      and de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
    limit 1
  `;
  if (!row) return null;
  return { documentEmbeddingId: row.document_embedding_id, question: row.question };
}

// The `n` cluster buckets whose centroids are nearest the question vector, in a
// saved cluster run. Centroids are stored as vector(dim) (see clusterStore), so
// this is an indexed cosine lookup like any other pgvector query.
export async function nearestBuckets(
  runId: string,
  queryVec: number[],
  n: number,
): Promise<NearestBucket[]> {
  const qlit = vectorLiteral(queryVec);
  const rows = await sql<{ id: string; ordinal: number; similarity: number }[]>`
    select id, ordinal, 1 - (centroid <=> ${qlit}::vector) as similarity
    from clusters
    where cluster_run_id = ${runId}
    order by centroid <=> ${qlit}::vector
    limit ${n}
  `;
  return rows.map((r) => ({
    clusterId: r.id,
    ordinal: r.ordinal,
    similarity: Number(r.similarity),
  }));
}

// The `limit` chunks in the given buckets that sit nearest the question (cosine,
// active-config scoped). This is the candidate pool the ranking is built from.
export async function poolFromBuckets(
  clusterIds: string[],
  queryVec: number[],
  limit: number,
): Promise<PoolCandidate[]> {
  const table = await activeChunksTable();
  if (!table || clusterIds.length === 0) return [];
  const qlit = vectorLiteral(queryVec);
  const rows = await sql<
    {
      id: string;
      file_name: string;
      position: number | null;
      text: string;
      similarity: number;
    }[]
  >`
    select c.id, d.file_name, c.position, c.text,
           1 - (c.embedding <=> ${qlit}::vector) as similarity
    from chunk_clusters cc
    join ${sql(table)} c on c.id = cc.chunk_id
    join documents d on d.id = c.document_id
    join document_embeddings de on de.id = c.document_embedding_id
    where cc.cluster_id = any(${clusterIds}::uuid[])
      and de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
    order by c.embedding <=> ${qlit}::vector
    limit ${limit}
  `;
  return rows.map((r) => ({
    chunkId: r.id,
    fileName: r.file_name,
    position: r.position,
    text: r.text,
    similarity: Number(r.similarity),
  }));
}

// Full text + labels for a set of chunk ids under the active config, in the
// requested order. Used to render a ranking's items (pool may be stale).
export async function getRankingChunks(
  ids: string[],
): Promise<Map<string, { fileName: string; position: number | null; text: string }>> {
  if (ids.length === 0) return new Map();
  const table = await activeChunksTable();
  if (!table) return new Map();
  const rows = await sql<
    { id: string; file_name: string; position: number | null; text: string }[]
  >`
    select c.id, d.file_name, c.position, c.text
    from ${sql(table)} c
    join documents d on d.id = c.document_id
    join document_embeddings de on de.id = c.document_embedding_id
    where c.id = any(${ids}::uuid[])
      and de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
  `;
  return new Map(
    rows.map((r) => [r.id, { fileName: r.file_name, position: r.position, text: r.text }]),
  );
}

// Every stored ranking for a question under the active config, newest first.
export async function listRankings(questionId: string): Promise<StoredRanking[]> {
  const rows = await sql<
    {
      id: string;
      kind: RankingKind;
      is_truth: boolean;
      chunk_ids: string[];
      details: Record<string, unknown>;
      created_at: Date;
    }[]
  >`
    select r.id, r.kind, r.is_truth, r.chunk_ids, r.details, r.created_at
    from eval_rankings r
    join document_embeddings de on de.id = r.document_embedding_id
    where r.eval_question_id = ${questionId}
      and de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
    order by r.created_at desc
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    isTruth: r.is_truth,
    chunkIds: r.chunk_ids,
    details: r.details,
    createdAt: r.created_at.getTime(),
  }));
}

// Insert or replace one ranking of a given kind (one per question/config/kind).
// is_truth is left untouched on update and defaults false on insert — promotion
// goes through setTruth so the single-truth invariant holds. Returns the row id.
export async function upsertRanking(args: {
  questionId: string;
  documentEmbeddingId: string;
  kind: RankingKind;
  chunkIds: string[];
  details: Record<string, unknown>;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into eval_rankings
      (eval_question_id, document_embedding_id, kind, chunk_ids, details)
    values
      (${args.questionId}, ${args.documentEmbeddingId}, ${args.kind},
       ${args.chunkIds}::uuid[],
       ${sql.json(args.details as Parameters<typeof sql.json>[0])})
    on conflict (eval_question_id, document_embedding_id, kind)
      do update set chunk_ids = excluded.chunk_ids,
                    details   = excluded.details,
                    created_at = now()
    returning id
  `;
  return row.id;
}

// Promote one ranking to ground truth for its question/config, clearing any
// previous truth in the same scope. Returns false if the id doesn't resolve.
export async function setTruth(
  questionId: string,
  documentEmbeddingId: string,
  rankingId: string,
): Promise<boolean> {
  return await sql.begin(async (tx) => {
    await tx`
      update eval_rankings set is_truth = false
      where eval_question_id = ${questionId}
        and document_embedding_id = ${documentEmbeddingId}
        and is_truth
    `;
    const rows = await tx`
      update eval_rankings set is_truth = true
      where id = ${rankingId}
        and eval_question_id = ${questionId}
        and document_embedding_id = ${documentEmbeddingId}
      returning id
    `;
    return rows.length > 0;
  });
}

// Ideal (ground-truth) order for each of the given questions under the active
// config, as questionId -> chunkIds. Questions without a truth ranking are
// simply absent. Backs the graded nDCG in evalStore.getSummary.
export async function getTruthOrder(
  questionIds: string[],
): Promise<Map<string, string[]>> {
  if (questionIds.length === 0) return new Map();
  const rows = await sql<{ eval_question_id: string; chunk_ids: string[] }[]>`
    select r.eval_question_id, r.chunk_ids
    from eval_rankings r
    join document_embeddings de on de.id = r.document_embedding_id
    where r.is_truth
      and r.eval_question_id = any(${questionIds}::uuid[])
      and de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
  `;
  return new Map(rows.map((r) => [r.eval_question_id, r.chunk_ids]));
}

export async function deleteRanking(id: string): Promise<boolean> {
  const rows = await sql`delete from eval_rankings where id = ${id} returning id`;
  return rows.length > 0;
}
