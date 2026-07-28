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
import { EF_SEARCH, vectorLiteral } from "@/lib/rag/vectorStore";

export type RankingKind = "aggregate" | "llm_pool" | "llm_rerank" | "manual";

export type StoredRanking = {
  id: string;
  kind: RankingKind;
  isTruth: boolean;
  chunkIds: string[]; // ideal order, best-first
  details: Record<string, unknown>;
  createdAt: number;
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

export type QuestionScope = {
  documentEmbeddingId: string; // active-config embedding run a ranking is filed under
  question: string; // the question text — embedded + sent to the LLM ranker
  documentId: string; // the question's source document
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

// The `limit` chunks in the ACTIVE CONFIG nearest the question vector — the
// candidate pool a graded ranking is built from. Same HNSW pattern as
// vectorStore.query: config-filtered ANN with ef_search raised inside the txn,
// because the config_id predicate would otherwise starve the top-k once several
// configs share a chunk table (docs/multi-config-plan.md §5.3). Scoping via the
// chunk table's OWN config_id column — rather than joining document_embeddings
// for it, the way the old bucket pool did — keeps the scope a plain column
// predicate the index scan can apply as it walks; a join can't be pushed in
// there, so it would only filter after the ANN had already picked its rows.
//
// This is deliberately the same neighbourhood the retriever searches, so the
// ideal ranking is drawn from the chunks retrieval could actually return.
// Empty when nothing is ingested under this config yet.
export async function poolNearest(
  queryVec: number[],
  limit: number,
): Promise<PoolCandidate[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  const qlit = vectorLiteral(queryVec);

  // HNSW POST-filters: the scan walks ef_search candidates and only then drops
  // the ones belonging to other configs sharing this table. vectorStore's
  // EF_SEARCH is sized for topK (5), so reusing it verbatim would starve a pool
  // an order of magnitude larger — once a few configs share a corpus, 100
  // candidates may not yield 30 survivors. A short pool doesn't error; it
  // silently truncates the ideal ranking, which deflates every nDCG scored
  // against it. So scale the depth with the ask, floored at the shared constant.
  // Interpolated via unsafe(), hence the integer guard: `limit` is a parameter
  // here, not a trusted constant like EF_SEARCH.
  const ef = Math.max(EF_SEARCH, Math.trunc(limit) * 4);
  if (!Number.isSafeInteger(ef) || ef <= 0) {
    throw new Error(`poolNearest: invalid ef_search ${ef} for limit ${limit}.`);
  }

  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.ef_search = ${ef}`);
    return tx<
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
      from ${tx(table)} c
      join documents d on d.id = c.document_id
      where c.config_id = ${activeConfig().id}
      order by c.embedding <=> ${qlit}::vector
      limit ${limit}
    `;
  });
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

// listRankings for MANY questions in one round-trip, as questionId -> rankings
// (newest first, same as the single-question form). The bulk LLM pass needs every
// question's aggregate + llm_rerank row just to decide who to skip, and doing
// that one query per question is an N+1 over the whole labeled set. Questions
// with no rankings are simply absent from the map.
export async function listRankingsByQuestions(
  questionIds: string[],
): Promise<Map<string, StoredRanking[]>> {
  if (questionIds.length === 0) return new Map();
  const rows = await sql<
    {
      eval_question_id: string;
      id: string;
      kind: RankingKind;
      is_truth: boolean;
      chunk_ids: string[];
      details: Record<string, unknown>;
      created_at: Date;
    }[]
  >`
    select r.eval_question_id, r.id, r.kind, r.is_truth, r.chunk_ids, r.details,
           r.created_at
    from eval_rankings r
    join document_embeddings de on de.id = r.document_embedding_id
    where r.eval_question_id = any(${questionIds}::uuid[])
      and de.config_id = ${activeConfig().id}
    order by r.created_at desc
  `;
  const byQuestion = new Map<string, StoredRanking[]>();
  for (const r of rows) {
    const list = byQuestion.get(r.eval_question_id) ?? [];
    list.push({
      id: r.id,
      kind: r.kind,
      isTruth: r.is_truth,
      chunkIds: r.chunk_ids,
      details: r.details,
      createdAt: r.created_at.getTime(),
    });
    byQuestion.set(r.eval_question_id, list);
  }
  return byQuestion;
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
