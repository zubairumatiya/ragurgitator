// ---------------------------------------------------------------------------
// DB layer for per-question graded nDCG rankings (migrations/0009). Raw SQL via
// the shared `sql` client, no business logic — orchestration lives in ranking.ts.
//
// Everything is scoped to the ACTIVE config via de.config_id (from
// activeConfig()), like evalStore.ts / clusterStore.ts. A ranking is tied to the
// question's active-config embedding run (document_embedding_id), so changing the
// config makes a question's rankings stop matching and it reads ungraded again.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { retrievalStateFingerprint } from "@/lib/rag/overrideStore";
import { vectorLiteral } from "@/lib/rag/vectorStore";

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
  const cfg = activeConfig();
  const rows = await sql`
    select 1 from document_embeddings where config_id = ${cfg.id} limit 1
  `;
  return rows.length > 0 ? cfg.chunksTable : null;
}

// Total chunks under the active config — the denominator for the bucket-nDCG
// saving (docs/savings-accounting-plan.md §2 #5): a naive aggregate would embed
// ALL of these under each non-base model, vs. the small bucket pool we actually
// embed. 0 when nothing is ingested yet.
export async function countCorpusChunks(): Promise<number> {
  const table = await activeChunksTable();
  if (!table) return 0;
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql(table)} where config_id = ${activeConfig().id}
  `;
  return row?.n ?? 0;
}

export type QuestionScope = {
  documentEmbeddingId: string; // active-config embedding run a ranking is filed under
  question: string; // the question text — embedded + sent to the LLM ranker
  documentId: string; // the question's source document — for preset-coverage flags
};

// The question's text + the active-config embedding run its ground-truth label
// uses (the scope a ranking is filed under). Null when the question has no label
// under the active config (stale id / wrong config).
export async function getQuestionScope(
  questionId: string,
): Promise<QuestionScope | null> {
  const [row] = await sql<
    { document_embedding_id: string; question: string; document_id: string }[]
  >`
    select l.document_embedding_id, q.question, q.document_id
    from eval_labels l
    join eval_questions q on q.id = l.eval_question_id
    join document_embeddings de on de.id = l.document_embedding_id
    where l.eval_question_id = ${questionId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!row) return null;
  return {
    documentEmbeddingId: row.document_embedding_id,
    question: row.question,
    documentId: row.document_id,
  };
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
      and de.config_id = ${activeConfig().id}
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
      and de.config_id = ${activeConfig().id}
  `;
  return new Map(
    rows.map((r) => [r.id, { fileName: r.file_name, position: r.position, text: r.text }]),
  );
}

// The active model's latest retrieved order (top-k chunk ids, in rank order) for
// a question under the active config — the order graded nDCG scores against an
// ideal ranking. Empty when the question hasn't been scored under this config, so
// callers can tell "unscored" (no order) from "scored but missed" (order, no hit).
export async function getRetrievedOrder(questionId: string): Promise<string[]> {
  // Prefer the result scored under the CURRENT override state (0022), like
  // getSummary — so nDCG grades the same retrieval the dashboard shows, even
  // right after a delegate revert resurrects an older matching result.
  const currentState = await retrievalStateFingerprint();
  const rows = await sql<{ retrieved_ids: string[] }[]>`
    select res.retrieved_ids
    from eval_results res
    join eval_labels l on l.id = res.eval_label_id
    join document_embeddings de on de.id = l.document_embedding_id
    where l.eval_question_id = ${questionId}
      and de.config_id = ${activeConfig().id}
    order by (res.retrieval_state is not distinct from ${currentState}) desc,
             res.scored_at desc
    limit 1
  `;
  return rows[0]?.retrieved_ids ?? [];
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
      and de.config_id = ${activeConfig().id}
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
      and de.config_id = ${activeConfig().id}
  `;
  return new Map(rows.map((r) => [r.eval_question_id, r.chunk_ids]));
}

// The KIND of each question's official (is_truth) ranking, active-config scoped.
// Lets the bulk rebuilder tell an aggregate truth (safe to refresh in place)
// from a deliberate manual/LLM truth (left alone). Questions with no truth are
// simply absent from the map.
export async function truthKindByQuestion(
  questionIds: string[],
): Promise<Map<string, RankingKind>> {
  if (questionIds.length === 0) return new Map();
  const rows = await sql<{ eval_question_id: string; kind: RankingKind }[]>`
    select r.eval_question_id, r.kind
    from eval_rankings r
    join document_embeddings de on de.id = r.document_embedding_id
    where r.is_truth
      and r.eval_question_id = any(${questionIds}::uuid[])
      and de.config_id = ${activeConfig().id}
  `;
  return new Map(rows.map((r) => [r.eval_question_id, r.kind]));
}

export async function deleteRanking(id: string): Promise<boolean> {
  const rows = await sql`delete from eval_rankings where id = ${id} returning id`;
  return rows.length > 0;
}
