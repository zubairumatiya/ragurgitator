// ---------------------------------------------------------------------------
// DB layer for retrieval evals (Recall@k). Mirrors vectorStore.ts: raw SQL via
// the shared `sql` client, no business logic. The orchestration lives in
// eval.ts.
//
// Everything here is scoped to the ACTIVE config (config.embeddingModel +
// chunkSize + chunkOverlap). Questions are document-scoped; their ground-truth
// chunk for a given config lives in eval_labels, so the same question can later
// be scored against other configs without re-authoring.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { config } from "@/lib/config";
import { chunksTable } from "@/lib/rag/vectorStore";

export type ChunkNeedingQuestions = {
  chunkId: string;
  text: string;
  documentId: string;
  documentEmbeddingId: string;
  needed: number; // how many more questions to generate for this chunk
};

export type QuestionToScore = {
  questionId: string;
  question: string;
  labelId: string;
  sourceChunkId: string;
};

export type ResultInsert = {
  questionId: string;
  labelId: string;
  k: number;
  hit: boolean;
  foundRank: number | null;
  retrievedIds: string[];
};

export type QuestionDetail = {
  questionId: string;
  question: string;
  source: string;
  documentId: string;
  fileName: string;
  expectedPosition: number | null;
  hit: boolean | null; // null = not scored yet
  foundRank: number | null;
  retrievedIds: string[] | null;
  scoredAt: number | null;
  stale: boolean; // true = edited since its last score; result shown is for the old text
};

export type DocumentBreakdown = {
  documentId: string;
  fileName: string;
  scored: number;
  hits: number;
};

export type RunSnapshot = {
  id: string;
  k: number;
  questionCount: number;
  hitCount: number;
  createdAt: number;
};

export type EvalSummary = {
  k: number;
  total: number; // questions with a label under the active config
  scored: number; // of those, how many have a result
  hits: number;
  recall: number | null; // hits / scored
  perDocument: DocumentBreakdown[];
  questions: QuestionDetail[];
  runs: RunSnapshot[];
  // Work "Process new chunks" would actually do, so the UI can disable it when
  // there's nothing pending. pendingChunks: chunks below the per-chunk question
  // target; pendingScoring: questions never scored or edited since last score.
  pendingChunks: number;
  pendingScoring: number;
};

// Resolve the chunks table for the active config. Returns null when nothing has
// been ingested under this config yet (so callers can no-op cleanly).
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

// Chunks (under the active config) that have fewer than `target` questions.
export async function chunksNeedingQuestions(
  target: number,
): Promise<ChunkNeedingQuestions[]> {
  const table = await activeChunksTable();
  if (!table) return [];

  const rows = await sql<
    {
      id: string;
      text: string;
      document_id: string;
      document_embedding_id: string;
      label_count: number;
    }[]
  >`
    select
      c.id,
      c.text,
      c.document_id,
      c.document_embedding_id,
      count(l.id)::int as label_count
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    left join eval_labels l
      on l.source_chunk_id = c.id
     and l.document_embedding_id = c.document_embedding_id
    where de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
    group by c.id, c.text, c.document_id, c.document_embedding_id
    having count(l.id) < ${target}
  `;

  return rows.map((r) => ({
    chunkId: r.id,
    text: r.text,
    documentId: r.document_id,
    documentEmbeddingId: r.document_embedding_id,
    needed: target - r.label_count,
  }));
}

// Insert one question (document-scoped) plus its ground-truth label for the
// current config, atomically.
export async function insertQuestionWithLabel(args: {
  documentId: string;
  documentEmbeddingId: string;
  sourceChunkId: string;
  question: string;
  expectedAnswer: string | null;
  generatorModel: string;
}): Promise<void> {
  await sql.begin(async (tx) => {
    const [q] = await tx<{ id: string }[]>`
      insert into eval_questions
        (document_id, question, expected_answer, source, generator_model)
      values
        (${args.documentId}, ${args.question}, ${args.expectedAnswer},
         'generated', ${args.generatorModel})
      returning id
    `;
    await tx`
      insert into eval_labels
        (eval_question_id, document_embedding_id, source_chunk_id)
      values
        (${q.id}, ${args.documentEmbeddingId}, ${args.sourceChunkId})
    `;
  });
}

// Questions (with a label under the active config) that have no fresh result —
// either never scored, or edited since their last score (updated_at newer).
export async function questionsNeedingScoring(): Promise<QuestionToScore[]> {
  const rows = await sql<
    {
      question_id: string;
      question: string;
      label_id: string;
      source_chunk_id: string;
    }[]
  >`
    select
      q.id as question_id,
      q.question,
      l.id as label_id,
      l.source_chunk_id
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
      and not exists (
        select 1 from eval_results r
        where r.eval_label_id = l.id
          and r.scored_at >= q.updated_at
      )
  `;

  return rows.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    labelId: r.label_id,
    sourceChunkId: r.source_chunk_id,
  }));
}

// Every question with a label under the active config, regardless of whether it
// already has a (fresh) result. Backs "Re-score all": re-running retrieval for all
// of these against the current corpus keeps recall apples-to-apples after the corpus
// changes (e.g. a doc was added/removed and now competes in the top-k).
// questionsNeedingScoring() is the incremental counterpart used by "Process new chunks".
export async function allLabeledQuestions(): Promise<QuestionToScore[]> {
  const rows = await sql<
    {
      question_id: string;
      question: string;
      label_id: string;
      source_chunk_id: string;
    }[]
  >`
    select
      q.id as question_id,
      q.question,
      l.id as label_id,
      l.source_chunk_id
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.model = ${config.embeddingModel}
      and de.chunk_size = ${config.chunkSize}
      and de.chunk_overlap = ${config.chunkOverlap}
  `;

  return rows.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    labelId: r.label_id,
    sourceChunkId: r.source_chunk_id,
  }));
}

// --- Query-embedding cache (see migrations/0003) -------------------------
// A question's query vector depends only on (text, model), so it's cached and
// reused across runs instead of re-embedded every "Re-score all". Keyed by
// (eval_question_id, model); invalidated on text edit (see updateQuestion) and
// cascade-deleted with the question/document.

// Cached query vectors for these questions under `model`, as questionId -> vector.
// Missing entries are simply absent from the map (caller embeds + caches those).
export async function getCachedQueryEmbeddings(
  questionIds: string[],
  model: string,
): Promise<Map<string, number[]>> {
  if (questionIds.length === 0) return new Map();
  const rows = await sql<{ eval_question_id: string; embedding: number[] }[]>`
    select eval_question_id, embedding
    from eval_question_embeddings
    where model = ${model}
      and eval_question_id = any(${questionIds}::uuid[])
  `;
  return new Map(rows.map((r) => [r.eval_question_id, r.embedding]));
}

// Store one freshly computed query vector. Idempotent on (question, model): a
// repeat overwrites, so it self-heals if a stale row ever lingers.
export async function putCachedQueryEmbedding(
  questionId: string,
  model: string,
  embedding: number[],
): Promise<void> {
  await sql`
    insert into eval_question_embeddings (eval_question_id, model, embedding)
    values (${questionId}, ${model}, ${embedding}::real[])
    on conflict (eval_question_id, model)
      do update set embedding = excluded.embedding, created_at = now()
  `;
}

export async function insertResults(rows: ResultInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        insert into eval_results
          (eval_question_id, eval_label_id, k, hit, found_rank, retrieved_ids)
        values
          (${r.questionId}, ${r.labelId}, ${r.k}, ${r.hit}, ${r.foundRank},
           ${r.retrievedIds}::uuid[])
      `;
    }
  });
}

// Freeze the current aggregate as a comparison point.
export async function createRunSnapshot(args: {
  questionCount: number;
  hitCount: number;
}): Promise<void> {
  await sql`
    insert into eval_runs
      (model, chunk_size, chunk_overlap, k, question_count, hit_count)
    values
      (${config.embeddingModel}, ${config.chunkSize}, ${config.chunkOverlap},
       ${config.topK}, ${args.questionCount}, ${args.hitCount})
  `;
}

export async function updateQuestion(id: string, text: string): Promise<void> {
  // The text changed, so every cached query vector for it (any model) is stale.
  // Drop them in the same transaction; they repopulate on the next score.
  await sql.begin(async (tx) => {
    await tx`
      update eval_questions
      set question = ${text}, source = 'manual', updated_at = now()
      where id = ${id}
    `;
    await tx`delete from eval_question_embeddings where eval_question_id = ${id}`;
  });
}

export async function deleteQuestion(id: string): Promise<void> {
  await sql`delete from eval_questions where id = ${id}`;
}

export async function getSummary(): Promise<EvalSummary> {
  const empty: EvalSummary = {
    k: config.topK,
    total: 0,
    scored: 0,
    hits: 0,
    recall: null,
    perDocument: [],
    questions: [],
    runs: [],
    pendingChunks: 0,
    pendingScoring: 0,
  };

  const table = await activeChunksTable();
  if (!table) return empty;

  const [detail, runRows, pendingChunkRows] = await Promise.all([
    sql<
      {
        question_id: string;
        question: string;
        source: string;
        document_id: string;
        updated_at: Date;
        file_name: string;
        expected_position: number | null;
        hit: boolean | null;
        found_rank: number | null;
        retrieved_ids: string[] | null;
        scored_at: Date | null;
      }[]
    >`
      with active_labels as (
        select l.id as label_id, l.eval_question_id, l.source_chunk_id
        from eval_labels l
        join document_embeddings de on de.id = l.document_embedding_id
        where de.model = ${config.embeddingModel}
          and de.chunk_size = ${config.chunkSize}
          and de.chunk_overlap = ${config.chunkOverlap}
      ),
      latest as (
        select distinct on (r.eval_question_id)
          r.eval_question_id, r.hit, r.found_rank, r.retrieved_ids, r.scored_at
        from eval_results r
        join active_labels al on al.label_id = r.eval_label_id
        order by r.eval_question_id, r.scored_at desc
      )
      select
        q.id as question_id,
        q.question,
        q.source,
        q.document_id,
        q.updated_at,
        d.file_name,
        c.position as expected_position,
        lt.hit,
        lt.found_rank,
        lt.retrieved_ids,
        lt.scored_at
      from eval_questions q
      join active_labels al on al.eval_question_id = q.id
      join documents d on d.id = q.document_id
      left join ${sql(table)} c on c.id = al.source_chunk_id
      left join latest lt on lt.eval_question_id = q.id
      order by lt.hit asc nulls first, d.file_name, c.position
    `,
    sql<
      {
        id: string;
        k: number;
        question_count: number;
        hit_count: number;
        created_at: Date;
      }[]
    >`
      select id, k, question_count, hit_count, created_at
      from eval_runs
      order by created_at desc
      limit 20
    `,
    // Count of chunks under the active config still below the question target —
    // the generation half of "Process new chunks". Mirrors chunksNeedingQuestions.
    sql<{ n: number }[]>`
      select count(*)::int as n
      from (
        select c.id
        from ${sql(table)} c
        join document_embeddings de on de.id = c.document_embedding_id
        left join eval_labels l
          on l.source_chunk_id = c.id
         and l.document_embedding_id = c.document_embedding_id
        where de.model = ${config.embeddingModel}
          and de.chunk_size = ${config.chunkSize}
          and de.chunk_overlap = ${config.chunkOverlap}
        group by c.id
        having count(l.id) < ${config.evalQuestionsPerChunk}
      ) t
    `,
  ]);

  const questions: QuestionDetail[] = detail.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    source: r.source,
    documentId: r.document_id,
    fileName: r.file_name,
    expectedPosition: r.expected_position,
    hit: r.hit,
    foundRank: r.found_rank,
    retrievedIds: r.retrieved_ids,
    scoredAt: r.scored_at ? r.scored_at.getTime() : null,
    // Edited after its last score -> the shown hit/miss is for the old text. Treat
    // as pending (it will be re-scored next run, see questionsNeedingScoring).
    stale: r.scored_at !== null && r.updated_at.getTime() > r.scored_at.getTime(),
  }));

  // Only fresh scores count toward recall; unscored and stale are pending.
  const scoredRows = questions.filter((q) => q.hit !== null && !q.stale);
  const hits = scoredRows.filter((q) => q.hit === true).length;

  // Questions "Process new chunks" would score: never scored, or edited since.
  // Matches questionsNeedingScoring() — no extra query needed.
  const pendingScoring = questions.filter((q) => q.hit === null || q.stale).length;

  const byDoc = new Map<string, DocumentBreakdown>();
  for (const q of questions) {
    let d = byDoc.get(q.documentId);
    if (!d) {
      d = { documentId: q.documentId, fileName: q.fileName, scored: 0, hits: 0 };
      byDoc.set(q.documentId, d);
    }
    if (q.hit !== null && !q.stale) {
      d.scored += 1;
      if (q.hit) d.hits += 1;
    }
  }

  return {
    k: config.topK,
    total: questions.length,
    scored: scoredRows.length,
    hits,
    recall: scoredRows.length > 0 ? hits / scoredRows.length : null,
    perDocument: [...byDoc.values()],
    questions,
    runs: runRows.map((r) => ({
      id: r.id,
      k: r.k,
      questionCount: r.question_count,
      hitCount: r.hit_count,
      createdAt: r.created_at.getTime(),
    })),
    pendingChunks: pendingChunkRows[0]?.n ?? 0,
    pendingScoring,
  };
}
