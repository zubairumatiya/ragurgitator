// ---------------------------------------------------------------------------
// DB layer for retrieval evals (Recall@k). Mirrors vectorStore.ts: raw SQL via
// the shared `sql` client, no business logic. The orchestration lives in
// eval.ts.
//
// Everything here is scoped to the ACTIVE config via de.config_id (resolved from
// activeConfig()). Questions are document-scoped; their ground-truth chunk for a
// given config lives in eval_labels, so the same question can later be scored
// against other configs without re-authoring. (config is still imported for the
// global evalQuestionsPerChunk target.)
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { reciprocalRank, ndcg } from "@/lib/rag/evalMetrics";
import {
  effectiveK,
  getActiveCriteria,
  type EvalCriteria,
} from "@/lib/rag/evalSettingsStore";
import { tokenizeWithOffsets } from "@/lib/rag/chunker";
import {
  clearRetrievalChanges,
  getRetrievalChangedAt,
  listRetrievalChanges,
  retrievalStateFingerprint,
  type OverrideKind,
} from "@/lib/rag/overrideStore";
import { getTruthOrder } from "@/lib/rag/rankingStore";

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
  retrievedScores: number[]; // per retrievedIds entry, same order: cosine similarity (base path) or rank-derived score (fused path)
  // Fingerprint of the override state this was scored under (0022) — stale iff
  // it differs from the current retrievalStateFingerprint().
  retrievalState: string;
};

export type QuestionDetail = {
  questionId: string;
  question: string;
  source: string;
  difficulty: string | null; // 'easy'|'medium'|'hard' for graded synthetic; null otherwise
  documentId: string;
  fileName: string;
  sourceChunkId: string; // the labeled chunk — questions are grouped by this on /eval
  expectedPosition: number | null;
  hit: boolean | null; // null = not scored yet
  foundRank: number | null;
  // Cosine sim of the ground-truth chunk in the stored retrieval (null when
  // unscored or the chunk wasn't in the retrieved superset) — feeds the chunk
  // card's "avg sim".
  storedSim: number | null;
  retrievedIds: string[] | null;
  scoredAt: number | null;
  // Edited since its last score OR scored before the last retrieval-shape
  // change — amber badge, re-scored next run. Retrieval-stale rows still count
  // toward the rates; edit-stale ones don't (their score is for the old text).
  stale: boolean;
  editStale: boolean; // the excluded-from-rates subset of `stale`
  // Graded nDCG@k against this question's official ideal ranking; null when it
  // has no ranking yet or no fresh score (ungraded → grey chip on /eval).
  ndcg: number | null;
  // "Ignore in rates" (§7): still rendered (greyed) but excluded from the
  // Recall/nDCG aggregates, the min-rate pass/fail counts, and autotune targeting.
  ignored: boolean;
};

// One autotune-run outcome row for the yellow ◷ hover (§6.4): a question's
// per-metric before → after under the chunk's applied override.
export type OverrideOutcome = {
  question: string;
  difficulty: string | null;
  metric: string; // 'recall' | 'ndcg'
  beforeValue: number | null;
  beforeRank: number | null;
  afterValue: number | null;
  afterRank: number | null;
};

// A chunk's active override, for the /eval chunk-header badges: yellow ◷ (has
// an override; hover shows `outcomes`) and red ❗ (`hasGap` — its pieces don't
// cover the source chunk's full token span, §6.4).
export type ChunkOverrideInfo = {
  chunkId: string;
  kind: OverrideKind;
  model: string;
  pieceCount: number;
  hasGap: boolean;
  outcomes: OverrideOutcome[];
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
  mrr: number | null; // null for snapshots predating migration 0007
  ndcg: number | null;
  createdAt: number;
};

// The active config's basics, surfaced to the dashboard so the Settings UI can
// show current settings and the Bulk-actions "new config" shortcut can pre-fill.
export type EvalConfigInfo = {
  id: string;
  corpusId: string | null; // null = detached config (0017)
  baseModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
};

export type EvalSummary = {
  // `k` stays = recallK for back-compat (run progress / explain). recallK and
  // ndcgK are the effective per-metric depths (A1).
  k: number;
  recallK: number;
  ndcgK: number;
  total: number; // questions with a label under the active config
  scored: number; // of those, how many have a result
  hits: number;
  recall: number | null; // hits / scored
  // Mean reciprocal rank over the same fresh-scored set as recall; null when
  // nothing is scored, like recall.
  mrr: number | null;
  // Mean graded nDCG@k (see lib/rag/evalMetrics.ndcg) over only the questions
  // that have an official ideal ranking AND a fresh score; null when none do.
  ndcg: number | null;
  // How many questions feed that nDCG average — the "5" in the dashboard's 5/n
  // (n = total). Questions without a ground-truth ranking aren't graded.
  ndcgCovered: number;
  perDocument: DocumentBreakdown[];
  questions: QuestionDetail[];
  runs: RunSnapshot[];
  // Work "Process new chunks" would actually do, so the UI can disable it when
  // there's nothing pending. pendingChunks: chunks below the per-chunk question
  // target; pendingScoring: questions never scored or edited since last score.
  pendingChunks: number;
  pendingScoring: number;
  // Of pendingScoring, how many are stale ONLY because retrieval changed shape
  // after they were scored (an override/delegate set or cleared). These still
  // COUNT toward the rates (approximate is better than a cratered sample); the
  // dashboard shows the stale badge while this is non-zero.
  retrievalStale: number;
  // The logged override/delegate changes behind retrievalStale (0021), newest
  // first — the stale badge's hover list. Empty when nothing is stale.
  retrievalChanges: { description: string; at: number }[];
  // Total chunks under the active config — gates bulk "Add question" (no chunks
  // = nothing to generate against).
  chunkCount: number;
  // The saved eval criteria (metrics/k/min-rate/difficulties/autotune) and the
  // active config basics — for the Settings dropdown and Bulk-actions pre-fill.
  criteria: EvalCriteria;
  config: EvalConfigInfo;
  // Active per-chunk overrides (Phase D badges) — empty when none.
  overrides: ChunkOverrideInfo[];
};

// Resolve the chunks table for the active config. Returns null when nothing has
// been ingested under this config yet (so callers can no-op cleanly).
async function activeChunksTable(): Promise<string | null> {
  const cfg = activeConfig();
  const rows = await sql`
    select 1 from document_embeddings where config_id = ${cfg.id} limit 1
  `;
  return rows.length > 0 ? cfg.chunksTable : null;
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
    where de.config_id = ${activeConfig().id}
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

// One (chunk, difficulty) generation gap: a chunk under the active config that
// has no question yet at `difficulty`. Drives the difficulty-driven generator
// (Phase A) — generation is now "one question per selected difficulty per chunk"
// instead of a fixed per-chunk count.
export type ChunkDifficultyGap = {
  chunkId: string;
  text: string;
  documentId: string;
  documentEmbeddingId: string;
  difficulty: string;
};

// For each requested difficulty, the chunks under the active config that lack a
// question at that difficulty. The cross join fans every chunk out across the
// requested difficulties; the NOT EXISTS keeps only the missing pairs.
// `documentId` (bulk-actions document scope) narrows to one document.
export async function chunksNeedingQuestionsByDifficulty(
  difficulties: string[],
  documentIds?: string[],
): Promise<ChunkDifficultyGap[]> {
  const table = await activeChunksTable();
  if (!table || difficulties.length === 0) return [];
  // Bulk-actions scope: one or more documents; null/empty = the whole corpus.
  const docScope = documentIds && documentIds.length > 0 ? documentIds : null;

  const rows = await sql<
    {
      id: string;
      text: string;
      document_id: string;
      document_embedding_id: string;
      difficulty: string;
    }[]
  >`
    select c.id, c.text, c.document_id, c.document_embedding_id, d.difficulty
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    cross join unnest(${difficulties}::text[]) as d(difficulty)
    where de.config_id = ${activeConfig().id}
      and (${docScope}::uuid[] is null or c.document_id = any(${docScope}::uuid[]))
      and not exists (
        select 1
        from eval_labels l
        join eval_questions q on q.id = l.eval_question_id
        where l.source_chunk_id = c.id
          and l.document_embedding_id = c.document_embedding_id
          and q.difficulty = d.difficulty
      )
    order by c.position, d.difficulty
  `;

  return rows.map((r) => ({
    chunkId: r.id,
    text: r.text,
    documentId: r.document_id,
    documentEmbeddingId: r.document_embedding_id,
    difficulty: r.difficulty,
  }));
}

// Insert one question (document-scoped) plus its ground-truth label for the
// given config, atomically. Used by both generated questions (source='generated',
// generatorModel set) and manual additions (source='manual', generatorModel null).
export async function insertQuestionWithLabel(args: {
  documentId: string;
  documentEmbeddingId: string;
  sourceChunkId: string;
  question: string;
  expectedAnswer: string | null;
  source?: "generated" | "manual";
  generatorModel: string | null;
  difficulty?: string | null; // graded synthetic only; null for manual / default-generated
}): Promise<void> {
  const source = args.source ?? "generated";
  await sql.begin(async (tx) => {
    const [q] = await tx<{ id: string }[]>`
      insert into eval_questions
        (document_id, question, expected_answer, source, generator_model, difficulty)
      values
        (${args.documentId}, ${args.question}, ${args.expectedAnswer},
         ${source}, ${args.generatorModel}, ${args.difficulty ?? null})
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

// Add a hand-written question labeled to a specific chunk under the active config.
// Resolves the chunk to its document + embedding-run so the label is correct, then
// inserts as a 'manual' question. Returns false when the chunk isn't part of the
// active config's corpus (stale id, wrong config). Scoring happens on the next
// "Process new chunks" / "Re-score all" like any other unscored question.
export async function addManualQuestion(
  chunkId: string,
  question: string,
): Promise<boolean> {
  const table = await activeChunksTable();
  if (!table) return false;

  const [chunk] = await sql<
    { document_id: string; document_embedding_id: string }[]
  >`
    select c.document_id, c.document_embedding_id
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where c.id = ${chunkId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!chunk) return false;

  await insertQuestionWithLabel({
    documentId: chunk.document_id,
    documentEmbeddingId: chunk.document_embedding_id,
    sourceChunkId: chunkId,
    question,
    expectedAnswer: null,
    source: "manual",
    generatorModel: null,
  });
  return true;
}

// Resolve a chunk (under the active config) to the text + ids needed to author a
// synthetic question for it on demand. Returns null when the chunk isn't part of
// the active config's corpus (stale id, wrong config). Mirrors the resolution in
// addManualQuestion but also returns the chunk text for the generator.
export async function getChunkForGeneration(
  chunkId: string,
): Promise<{ text: string; documentId: string; documentEmbeddingId: string } | null> {
  const table = await activeChunksTable();
  if (!table) return null;

  const [chunk] = await sql<
    { text: string; document_id: string; document_embedding_id: string }[]
  >`
    select c.text, c.document_id, c.document_embedding_id
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where c.id = ${chunkId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!chunk) return null;

  return {
    text: chunk.text,
    documentId: chunk.document_id,
    documentEmbeddingId: chunk.document_embedding_id,
  };
}

// Questions (with a label under the active config) that have no fresh result —
// never scored, edited since their last score (updated_at newer), or scored
// before the config's retrieval last changed shape (an override/delegate set or
// cleared — see retrieval_changed_at, 0019).
export async function questionsNeedingScoring(): Promise<QuestionToScore[]> {
  const [retrievalChangedAt, currentState] = await Promise.all([
    getRetrievalChangedAt(),
    retrievalStateFingerprint(),
  ]);
  // A result is retrieval-fresh when its 0022 fingerprint matches the CURRENT
  // override state (so a set-then-reverted change needs no re-score); legacy
  // rows without one fall back to the 0019 timestamp rule.
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
    where de.config_id = ${activeConfig().id}
      and not exists (
        select 1 from eval_results r
        where r.eval_label_id = l.id
          and r.scored_at >= q.updated_at
          and (
            r.retrieval_state = ${currentState}
            or (r.retrieval_state is null
                and (${retrievalChangedAt}::timestamptz is null
                     or r.scored_at >= ${retrievalChangedAt}))
          )
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
// `documentIds` (bulk-actions scope) narrows to those documents' questions;
// null/empty = every document.
export async function allLabeledQuestions(documentIds?: string[]): Promise<QuestionToScore[]> {
  const docScope = documentIds && documentIds.length > 0 ? documentIds : null;
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
    where de.config_id = ${activeConfig().id}
      and (${docScope}::uuid[] is null or q.document_id = any(${docScope}::uuid[]))
  `;

  return rows.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    labelId: r.label_id,
    sourceChunkId: r.source_chunk_id,
  }));
}

// One question's scoring inputs by id, under the active config; null when it has
// no label here. The single-question counterpart to questionsNeedingScoring /
// allLabeledQuestions, for scoring one question on demand (the nDCG panel).
export async function getQuestionToScore(
  questionId: string,
): Promise<QuestionToScore | null> {
  const [row] = await sql<
    { question_id: string; question: string; label_id: string; source_chunk_id: string }[]
  >`
    select q.id as question_id, q.question, l.id as label_id, l.source_chunk_id
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where q.id = ${questionId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!row) return null;
  return {
    questionId: row.question_id,
    question: row.question,
    labelId: row.label_id,
    sourceChunkId: row.source_chunk_id,
  };
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

// One chunk in the "why did it miss?" view: a retrieved result with its text and
// rank, flagged when it's the ground-truth chunk.
export type ExplainChunk = {
  chunkId: string;
  fileName: string | null; // which document it came from — retrieval spans all docs
  position: number | null;
  text: string;
  rank: number; // 1-based position in the retrieved list
  score: number | null; // cosine similarity to the query; null for pre-0004 results
  isExpected: boolean;
};

// Drill-down for a single question: the ground-truth chunk plus exactly what the
// latest scoring run retrieved (in rank order). For a hit the expected chunk is
// flagged at its rank; for a miss it's absent and you see the distractors that
// beat it. Scoped to the active config, like everything else here.
export type QuestionExplain = {
  expected: {
    chunkId: string;
    fileName: string | null;
    position: number | null;
    text: string | null;
    // On a miss, the expected chunk's similarity to the query and its EXACT rank in
    // the full corpus (computed on demand from the cached query vector), so you can
    // see how far below the top-k it fell. Both null on a hit (shown in the list
    // instead) or when the vector isn't cached. Rank is exact (full scan, no HNSW),
    // so rank <= k on a recorded miss means HNSW dropped it.
    score: number | null;
    rank: number | null;
  } | null;
  // The chunks ranked between the top-k cut-off and the expected chunk (ranks
  // k+1 .. rank-1), in rank order — the "what beat it" gap. Empty on a hit.
  between: ExplainChunk[];
  retrieved: ExplainChunk[];
  k: number | null;
  scoredAt: number | null;
};

// `retrievalState` narrows the drill-down to results scored under a specific
// override state (0022) — the baseline row passes 'baseline' to show what pure
// base-model retrieval returned while a delegate is active. When absent, the
// newest result matching the CURRENT state wins (falling back to newest
// overall), mirroring getSummary — so the drill-down always explains the same
// result the badge shows, including after a delegate revert.
export async function getQuestionExplain(
  questionId: string,
  retrievalState?: string,
): Promise<QuestionExplain> {
  const empty: QuestionExplain = {
    expected: null,
    between: [],
    retrieved: [],
    k: null,
    scoredAt: null,
  };
  const table = await activeChunksTable();
  if (!table) return empty;

  // Ground-truth label for this question under the active config.
  const [label] = await sql<{ label_id: string; source_chunk_id: string }[]>`
    select l.id as label_id, l.source_chunk_id
    from eval_labels l
    join document_embeddings de on de.id = l.document_embedding_id
    where l.eval_question_id = ${questionId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!label) return empty;

  // Latest score for that label; retrieved_ids are stored in rank order.
  // Prefer the requested state (or the current one) — see the doc comment.
  const preferState = retrievalState ?? (await retrievalStateFingerprint());
  const [result] = await sql<
    {
      retrieved_ids: string[];
      retrieved_scores: number[] | null;
      k: number;
      scored_at: Date;
    }[]
  >`
    select retrieved_ids, retrieved_scores, k, scored_at
    from eval_results
    where eval_label_id = ${label.label_id}
      and (${retrievalState ?? null}::text is null
           or retrieval_state = ${retrievalState ?? null})
    order by (retrieval_state is not distinct from ${preferState}) desc,
             scored_at desc
    limit 1
  `;

  const retrievedIds = result?.retrieved_ids ?? [];
  const retrievedScores = result?.retrieved_scores ?? null;
  // One lookup covers the expected chunk and everything retrieved.
  const ids = [...new Set([label.source_chunk_id, ...retrievedIds])];
  const chunkRows = await sql<
    { id: string; file_name: string; position: number | null; text: string }[]
  >`
    select c.id, d.file_name, c.position, c.text
    from ${sql(table)} c
    join documents d on d.id = c.document_id
    where c.id = any(${ids}::uuid[])
  `;
  const byId = new Map(chunkRows.map((c) => [c.id, c]));

  // On a miss the expected chunk isn't in the top-k, so its score/rank weren't
  // stored. Compute them on demand from the cached query vector (0003): rank the
  // WHOLE corpus exactly (row_number, full scan — no HNSW), pull the expected
  // chunk's rank + score, and return the chunks sitting between the top-k cut-off
  // and it (ranks k+1 .. rank-1) — the "what beat it" gap. Best-effort: stays null
  // / empty if the vector isn't cached (e.g. edited since scoring) so the
  // drill-down never breaks over it. Exact ranking means rank <= k here would mean
  // HNSW dropped a chunk it should have surfaced.
  const expectedInRetrieved = retrievedIds.includes(label.source_chunk_id);
  const kForRank = result?.k ?? activeConfig().topK;
  let expectedScore: number | null = null;
  let expectedRank: number | null = null;
  let between: ExplainChunk[] = [];
  if (!expectedInRetrieved) {
    try {
      const rows = await sql<
        {
          id: string;
          file_name: string;
          position: number | null;
          text: string;
          score: number;
          rn: number;
          expected_rn: number;
          expected_score: number;
          is_expected: boolean;
        }[]
      >`
        with q as (
          select embedding::vector as vec
          from eval_question_embeddings
          where eval_question_id = ${questionId}
            and model = ${activeConfig().embeddingModel}
          limit 1
        ),
        ranked as (
          select
            c.id,
            d.file_name,
            c.position,
            c.text,
            1 - (c.embedding <=> (select vec from q)) as score,
            (row_number() over (order by c.embedding <=> (select vec from q)))::int as rn
          from ${sql(table)} c
          join documents d on d.id = c.document_id
          where exists (select 1 from q)
        ),
        expected as (select rn, score from ranked where id = ${label.source_chunk_id})
        select
          r.id, r.file_name, r.position, r.text, r.score, r.rn,
          e.rn as expected_rn,
          e.score as expected_score,
          (r.id = ${label.source_chunk_id}) as is_expected
        from ranked r
        cross join expected e
        where r.id = ${label.source_chunk_id}
           or (r.rn > ${kForRank} and r.rn < e.rn)
        order by r.rn
      `;
      if (rows.length > 0) {
        expectedRank = Number(rows[0].expected_rn);
        expectedScore = Number(rows[0].expected_score);
        between = rows
          .filter((r) => !r.is_expected)
          .map((r) => ({
            chunkId: r.id,
            fileName: r.file_name,
            position: r.position,
            text: r.text,
            rank: Number(r.rn),
            score: Number(r.score),
            isExpected: false,
          }));
      }
    } catch {
      expectedScore = null;
      expectedRank = null;
      between = [];
    }
  }

  const expectedRow = byId.get(label.source_chunk_id);
  const retrieved: ExplainChunk[] = retrievedIds.map((id, i) => {
    const row = byId.get(id);
    return {
      chunkId: id,
      fileName: row?.file_name ?? null,
      position: row?.position ?? null,
      text: row?.text ?? "",
      rank: i + 1,
      score: retrievedScores?.[i] ?? null,
      isExpected: id === label.source_chunk_id,
    };
  });

  return {
    expected: {
      chunkId: label.source_chunk_id,
      fileName: expectedRow?.file_name ?? null,
      position: expectedRow?.position ?? null,
      text: expectedRow?.text ?? null,
      score: expectedScore,
      rank: expectedRank,
    },
    between,
    retrieved,
    k: result?.k ?? null,
    scoredAt: result ? result.scored_at.getTime() : null,
  };
}

// --- Re-chunk experiment (ephemeral, see lib/rag/eval.runRechunkExperiment) --
// A per-chunk "what-if": re-split ONE labeled chunk at a trial size/overlap and
// re-rank for its question, to see whether a smaller piece would have been
// retrieved. Nothing is persisted — these helpers only read the corpus and rank
// in-memory sub-chunk vectors against it, so the live index is never touched.

export type ExperimentContext = {
  chunkId: string;
  chunkText: string;
  question: string;
  fileName: string;
  queryVector: number[] | null; // cached query embedding, or null if not cached
};

// The labeled chunk + its question for a re-chunk experiment, scoped to the
// active config. Pulls the chunk's text (what we re-split), the question text
// (to embed on a cache miss), and the cached query vector when present. Null
// when the question has no label under the active config (stale id / wrong config).
export async function getExperimentContext(
  questionId: string,
): Promise<ExperimentContext | null> {
  const table = await activeChunksTable();
  if (!table) return null;

  const [row] = await sql<
    {
      chunk_id: string;
      chunk_text: string;
      question: string;
      file_name: string;
      query_vector: number[] | null;
    }[]
  >`
    select
      l.source_chunk_id as chunk_id,
      c.text as chunk_text,
      q.question,
      d.file_name,
      qe.embedding as query_vector
    from eval_labels l
    join eval_questions q on q.id = l.eval_question_id
    join document_embeddings de on de.id = l.document_embedding_id
    join ${sql(table)} c on c.id = l.source_chunk_id
    join documents d on d.id = q.document_id
    left join eval_question_embeddings qe
      on qe.eval_question_id = q.id and qe.model = ${activeConfig().embeddingModel}
    where q.id = ${questionId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!row) return null;
  return {
    chunkId: row.chunk_id,
    chunkText: row.chunk_text,
    question: row.question,
    fileName: row.file_name,
    queryVector: row.query_vector,
  };
}

export type ChunkWindowRows = {
  testPosition: number;
  testChunkId: string;
  totalChunks: number; // chunks in the doc under the active config (range bounds)
  chunks: { position: number; text: string }[]; // positions in [fromPos, toPos]
};

// Fetch a window of a question's document chunks (the labeled chunk plus the
// neighbors in [fromPos, toPos]) for the boundary editor, scoped to the active
// config. Returns null when the question has no label under the active config.
// Read-only; the stitching/tokenizing happens in eval.buildChunkWindow.
export async function getChunkWindow(
  questionId: string,
  fromPos: number,
  toPos: number,
): Promise<ChunkWindowRows | null> {
  const table = await activeChunksTable();
  if (!table) return null;

  const [test] = await sql<
    { position: number; chunk_id: string; document_id: string }[]
  >`
    select c.position, c.id as chunk_id, c.document_id
    from eval_labels l
    join eval_questions q on q.id = l.eval_question_id
    join document_embeddings de on de.id = l.document_embedding_id
    join ${sql(table)} c on c.id = l.source_chunk_id
    where q.id = ${questionId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!test) return null;

  const [counts] = await sql<{ total: number }[]>`
    select count(*)::int as total
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where c.document_id = ${test.document_id}
      and de.config_id = ${activeConfig().id}
  `;

  const rows = await sql<{ position: number; text: string }[]>`
    select c.position, c.text
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where c.document_id = ${test.document_id}
      and de.config_id = ${activeConfig().id}
      and c.position between ${fromPos} and ${toPos}
    order by c.position
  `;

  return {
    testPosition: test.position,
    testChunkId: test.chunk_id,
    totalChunks: counts?.total ?? rows.length,
    chunks: rows.map((r) => ({ position: r.position, text: r.text })),
  };
}

export type RankedChunk = {
  id: string; // chunk id, or "sub-<i>" for an experiment sub-chunk
  fileName: string | null; // null for sub-chunks (they share the source chunk's file)
  position: number | null; // corpus chunk position; null for sub-chunks
  subIndex: number | null; // 0-based index among sub-chunks; null for corpus chunks
  text: string;
  rank: number; // 1-based exact rank in the substituted corpus
  score: number; // cosine similarity to the query
};

// Exact full-scan rank of the query against the corpus with ONE chunk swapped
// for the supplied sub-chunks: (active-config chunks − sourceChunkId) ∪ subs.
// Same exact-ranking approach as getQuestionExplain, but the sub-chunk vectors
// are injected ad-hoc (never written to the table). Returns the top-k rows PLUS
// every sub-chunk row (even below k) so each sub-chunk's standing is known.
export async function rankWithSubstitutedChunk(args: {
  queryVector: number[];
  sourceChunkId: string;
  subTexts: string[];
  subVectors: number[][];
  k: number;
}): Promise<RankedChunk[]> {
  const table = await activeChunksTable();
  if (!table) return [];

  const queryLit = `[${args.queryVector.join(",")}]`;
  const indices = args.subTexts.map((_, i) => i);
  const subLits = args.subVectors.map((v) => `[${v.join(",")}]`);

  const rows = await sql<
    {
      id: string;
      file_name: string | null;
      position: number | null;
      sub_index: number | null;
      text: string;
      score: number;
      rn: number;
    }[]
  >`
    with q as (select ${queryLit}::vector as vec),
    sub as (
      select i as sub_index, txt as text, vec::vector as embedding
      from unnest(
        ${indices}::int[], ${args.subTexts}::text[], ${subLits}::text[]
      ) as t(i, txt, vec)
    ),
    corpus as (
      select
        c.id::text as id,
        d.file_name,
        c.position,
        null::int as sub_index,
        c.text,
        c.embedding::vector as embedding
      from ${sql(table)} c
      join documents d on d.id = c.document_id
      join document_embeddings de on de.id = c.document_embedding_id
      where de.config_id = ${activeConfig().id}
        and c.id <> ${args.sourceChunkId}
      union all
      select
        'sub-' || s.sub_index::text as id,
        null::text as file_name,
        null::int as position,
        s.sub_index,
        s.text,
        s.embedding
      from sub s
    ),
    ranked as (
      select
        id, file_name, position, sub_index, text,
        1 - (embedding <=> (select vec from q)) as score,
        (row_number() over (order by embedding <=> (select vec from q)))::int as rn
      from corpus
    )
    select id, file_name, position, sub_index, text, score, rn
    from ranked
    where rn <= ${args.k} or sub_index is not null
    order by rn
  `;

  return rows.map((r) => ({
    id: r.id,
    fileName: r.file_name,
    position: r.position,
    subIndex: r.sub_index,
    text: r.text,
    rank: Number(r.rn),
    score: Number(r.score),
  }));
}

// --- "Try a different model" experiment (see lib/rag/eval.runModelTrial) ------
// Per-chunk model A/B: re-rank the chunk's questions against a small CANDIDATE
// POOL (the chunk + its questions' top-k + optional hand-picked corpus chunks)
// re-embedded under an alternate model. Ranking happens in JS (eval.ts); these
// helpers only read the corpus and persist the runs the user chooses to keep.

export type ModelTrialChunk = {
  chunkId: string;
  text: string;
  fileName: string;
  position: number | null;
  documentEmbeddingId: string; // scopes a saved trial to the active config
};

export type ModelTrialQuestion = {
  questionId: string;
  question: string;
  storedHit: boolean | null; // latest full-corpus result; null if unscored
  storedRank: number | null; // found_rank; null on a miss or when unscored
  retrievedIds: string[]; // latest top-k ids — the candidate-pool seed; [] if unscored
};

export type PoolChunk = {
  chunkId: string;
  fileName: string;
  position: number | null;
  text: string;
};

export type CorpusChunkListItem = {
  chunkId: string;
  fileName: string;
  position: number | null;
  preview: string;
};

// One re-ranked pool chunk for a question under the trial model — a row in the
// trial's top-k, mirroring the question top-k drill-down. The label/text are
// resolved at display time from the trial's `pool`, so only ids are persisted.
export type TrialPoolHit = {
  chunkId: string;
  rank: number; // 1-based rank within the re-embedded pool
  score: number; // cosine similarity to the query under the trial model
  isExpected: boolean; // the chunk under test (ground truth)
  // For size / size+model variations the test chunk competes as PIECES; each
  // piece ranks separately and carries its 0-based index here. Null/absent for
  // whole chunks (model-only trials and every other pool chunk).
  subIndex?: number | null;
};

// One question's before/after in a model trial: its stored full-corpus result
// vs. its rank within the re-embedded pool under the trial model. This is the
// persisted per-question shape (eval_model_trials.results jsonb).
export type TrialQuestionOutcome = {
  questionId: string;
  question: string;
  storedHit: boolean | null;
  storedRank: number | null;
  newHit: boolean;
  newRank: number;
  newScore: number;
  // The trial model's top-k of the re-ranked pool for this question (capped at
  // k). Lets a saved trial show what accompanied/beat the chunk. Optional —
  // trials saved before this field existed simply omit it.
  topPool?: TrialPoolHit[];
};

// Which knob a saved trial turned: the model, the chunk's shape, or both.
export type TrialKind = "model" | "size" | "size+model";

export type SavedModelTrial = {
  id: string;
  baselineModel: string;
  trialModel: string;
  kind: TrialKind;
  // Uniform re-split knobs; null for model-only trials and custom (drag-border)
  // sections. pieceCount is set for every size / size+model trial.
  chunkSize: number | null;
  chunkOverlap: number | null;
  pieceCount: number | null;
  k: number;
  poolSize: number;
  // The candidate pool resolved to labels + text (in stored order), for the pool
  // tooltip and the per-question top-k. Stale ids (config changed since the trial
  // was saved) resolve to a "?" placeholder so the count still matches poolSize.
  pool: PoolChunk[];
  questionCount: number;
  hitCount: number; // hits under the trial model (in-pool)
  storedHitCount: number; // baseline hits (stored full-corpus result)
  results: TrialQuestionOutcome[];
  createdAt: number;
};

// The chunk under test, resolved to the bits a trial needs. Null when the chunk
// isn't part of the active config's corpus (stale id / wrong config).
export async function getModelTrialChunk(
  chunkId: string,
): Promise<ModelTrialChunk | null> {
  const table = await activeChunksTable();
  if (!table) return null;

  const [row] = await sql<
    {
      id: string;
      text: string;
      position: number | null;
      document_embedding_id: string;
      file_name: string;
    }[]
  >`
    select c.id, c.text, c.position, c.document_embedding_id, d.file_name
    from ${sql(table)} c
    join documents d on d.id = c.document_id
    join document_embeddings de on de.id = c.document_embedding_id
    where c.id = ${chunkId}
      and de.config_id = ${activeConfig().id}
    limit 1
  `;
  if (!row) return null;
  return {
    chunkId: row.id,
    text: row.text,
    fileName: row.file_name,
    position: row.position,
    documentEmbeddingId: row.document_embedding_id,
  };
}

// Chunk ids under the active config whose TEXT already has a cached 'document'
// embedding under `model` (0020 content-addressed cache) — free trial-pool
// candidates: delegate-space retrieval and past trials have already paid for
// them. Hash must mirror lib/rag/embedCache (sha256 hex over the exact UTF-8
// text). Cache table missing (0020 unapplied) → none.
export async function cachedChunkIdsForModel(model: string): Promise<string[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  try {
    const rows = await sql<{ id: string }[]>`
      select c.id
      from ${sql(table)} c
      join document_embeddings de on de.id = c.document_embedding_id
      join embedding_cache ec
        on ec.model = ${model}
       and ec.input_kind = 'document'
       and ec.text_hash = encode(sha256(convert_to(c.text, 'UTF8')), 'hex')
      where de.config_id = ${activeConfig().id}
    `;
    return rows.map((r) => r.id);
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

// The chunk's questions plus each one's latest stored result (the full-corpus
// baseline) and the top-k ids it retrieved (which seed the candidate pool).
export async function getModelTrialQuestions(
  chunkId: string,
): Promise<ModelTrialQuestion[]> {
  const currentState = await retrievalStateFingerprint();
  const rows = await sql<
    {
      question_id: string;
      question: string;
      hit: boolean | null;
      found_rank: number | null;
      retrieved_ids: string[] | null;
    }[]
  >`
    with active_labels as (
      select l.id as label_id, l.eval_question_id
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      where l.source_chunk_id = ${chunkId}
        and de.config_id = ${activeConfig().id}
    ),
    latest as (
      -- Same current-state preference as getSummary, so a trial's "stored"
      -- baseline column matches the result the dashboard shows.
      select distinct on (r.eval_question_id)
        r.eval_question_id, r.hit, r.found_rank, r.retrieved_ids
      from eval_results r
      join active_labels al on al.label_id = r.eval_label_id
      order by r.eval_question_id,
        (r.retrieval_state is not distinct from ${currentState}) desc,
        r.scored_at desc
    )
    select
      q.id as question_id,
      q.question,
      lt.hit,
      lt.found_rank,
      lt.retrieved_ids
    from eval_questions q
    join active_labels al on al.eval_question_id = q.id
    left join latest lt on lt.eval_question_id = q.id
    order by q.created_at
  `;

  return rows.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    storedHit: r.hit,
    storedRank: r.found_rank,
    retrievedIds: r.retrieved_ids ?? [],
  }));
}

// Full text for a set of chunk ids under the active config (the pool to embed).
// Silently drops ids not in the active corpus, so a stale selection just yields
// a smaller pool rather than an error.
export async function getChunksByIds(ids: string[]): Promise<PoolChunk[]> {
  if (ids.length === 0) return [];
  const table = await activeChunksTable();
  if (!table) return [];

  const rows = await sql<
    { id: string; position: number | null; text: string; file_name: string }[]
  >`
    select c.id, c.position, c.text, d.file_name
    from ${sql(table)} c
    join documents d on d.id = c.document_id
    join document_embeddings de on de.id = c.document_embedding_id
    where c.id = any(${ids}::uuid[])
      and de.config_id = ${activeConfig().id}
  `;
  return rows.map((r) => ({
    chunkId: r.id,
    fileName: r.file_name,
    position: r.position,
    text: r.text,
  }));
}

// The rest of the active-config corpus (excluding the given ids), as previews,
// for the trial's collapsed "add other chunks" picker.
export async function getCorpusChunkList(
  excludeIds: string[],
): Promise<CorpusChunkListItem[]> {
  const table = await activeChunksTable();
  if (!table) return [];

  // any('{}') matches nothing, so an empty exclude list returns the whole corpus.
  const rows = await sql<
    { id: string; position: number | null; preview: string; file_name: string }[]
  >`
    select c.id, c.position, left(c.text, 200) as preview, d.file_name
    from ${sql(table)} c
    join documents d on d.id = c.document_id
    join document_embeddings de on de.id = c.document_embedding_id
    where de.config_id = ${activeConfig().id}
      and not (c.id = any(${excludeIds}::uuid[]))
    order by d.file_name, c.position
  `;
  return rows.map((r) => ({
    chunkId: r.id,
    fileName: r.file_name,
    position: r.position,
    preview: r.preview,
  }));
}

// Persist a kept trial as a frozen snapshot (mirrors createRunSnapshot). Returns
// the new row's id + timestamp so the caller can render it without a re-fetch.
export async function insertModelTrial(args: {
  sourceChunkId: string;
  documentEmbeddingId: string;
  baselineModel: string;
  trialModel: string;
  kind: TrialKind;
  chunkSize: number | null;
  chunkOverlap: number | null;
  pieceCount: number | null;
  k: number;
  poolChunkIds: string[];
  questionCount: number;
  hitCount: number;
  storedHitCount: number;
  results: TrialQuestionOutcome[];
}): Promise<{ id: string; createdAt: number }> {
  const [row] = await sql<{ id: string; created_at: Date }[]>`
    insert into eval_model_trials
      (source_chunk_id, document_embedding_id, baseline_model, trial_model, kind,
       chunk_size, chunk_overlap, piece_count, k,
       pool_chunk_ids, question_count, hit_count, stored_hit_count, results)
    values
      (${args.sourceChunkId}, ${args.documentEmbeddingId}, ${args.baselineModel},
       ${args.trialModel}, ${args.kind},
       ${args.chunkSize}, ${args.chunkOverlap}, ${args.pieceCount}, ${args.k},
       ${args.poolChunkIds}::uuid[],
       ${args.questionCount}, ${args.hitCount}, ${args.storedHitCount},
       ${sql.json(args.results)})
    returning id, created_at
  `;
  return { id: row.id, createdAt: row.created_at.getTime() };
}

export async function listModelTrials(chunkId: string): Promise<SavedModelTrial[]> {
  const rows = await sql<
    {
      id: string;
      baseline_model: string;
      trial_model: string;
      kind: string;
      chunk_size: number | null;
      chunk_overlap: number | null;
      piece_count: number | null;
      k: number;
      pool_chunk_ids: string[];
      question_count: number;
      hit_count: number;
      stored_hit_count: number;
      results: TrialQuestionOutcome[];
      created_at: Date;
    }[]
  >`
    select id, baseline_model, trial_model, kind, chunk_size, chunk_overlap,
           piece_count, k, pool_chunk_ids,
           question_count, hit_count, stored_hit_count, results, created_at
    from eval_model_trials
    where source_chunk_id = ${chunkId}
    order by created_at desc
  `;

  // Resolve every trial's pool to labels/text in one query, then map each id back
  // in stored order. A stale id (config changed since save) gets a placeholder so
  // the pool length still reflects what was saved.
  const allPoolIds = [...new Set(rows.flatMap((r) => r.pool_chunk_ids))];
  const poolChunks = await getChunksByIds(allPoolIds);
  const byId = new Map(poolChunks.map((c) => [c.chunkId, c]));
  const resolvePool = (ids: string[]): PoolChunk[] =>
    ids.map(
      (id) => byId.get(id) ?? { chunkId: id, fileName: "?", position: null, text: "" },
    );

  return rows.map((r) => ({
    id: r.id,
    baselineModel: r.baseline_model,
    trialModel: r.trial_model,
    kind: r.kind as TrialKind,
    chunkSize: r.chunk_size,
    chunkOverlap: r.chunk_overlap,
    pieceCount: r.piece_count,
    k: r.k,
    poolSize: r.pool_chunk_ids.length,
    pool: resolvePool(r.pool_chunk_ids),
    questionCount: r.question_count,
    hitCount: r.hit_count,
    storedHitCount: r.stored_hit_count,
    results: r.results,
    createdAt: r.created_at.getTime(),
  }));
}

export async function deleteModelTrial(id: string): Promise<boolean> {
  const rows = await sql`delete from eval_model_trials where id = ${id} returning id`;
  return rows.length > 0;
}

export async function insertResults(rows: ResultInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        insert into eval_results
          (eval_question_id, eval_label_id, k, hit, found_rank, retrieved_ids,
           retrieved_scores, retrieval_state)
        values
          (${r.questionId}, ${r.labelId}, ${r.k}, ${r.hit}, ${r.foundRank},
           ${r.retrievedIds}::uuid[], ${r.retrievedScores}::real[],
           ${r.retrievalState})
      `;
    }
  });
}

// Freeze the current aggregate as a comparison point. config_id scopes the
// snapshot to the active config; the settings columns stay as a denormalized
// record of what produced it.
export async function createRunSnapshot(args: {
  questionCount: number;
  hitCount: number;
  mrr: number | null;
  ndcg: number | null;
  k?: number; // recall depth this run was scored at (A1); defaults to top_k
}): Promise<void> {
  const cfg = activeConfig();
  await sql`
    insert into eval_runs
      (config_id, model, chunk_size, chunk_overlap, k, question_count, hit_count, mrr, ndcg)
    values
      (${cfg.id}, ${cfg.embeddingModel}, ${cfg.chunkSize}, ${cfg.chunkOverlap},
       ${args.k ?? cfg.topK}, ${args.questionCount}, ${args.hitCount}, ${args.mrr},
       ${args.ndcg})
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

// Assemble the active config's per-chunk override info for the /eval badges:
// one row per overridden chunk (kind/model/piece count), its hover outcomes
// from the most recent autotune run that applied an override there, and the
// red-❗ gap flag. Gap detection (§6.4): only pieces that carry token spans can
// leave one (whole-chunk and uniform re-splits store NULL spans = full
// coverage); for those we tokenize the source chunk and check the spans cover
// [0, tokenCount) without holes. Both tables are tolerated missing (0013/0015
// or 0016 unapplied) so /eval keeps working pre-migration.
async function listChunkOverrideInfo(table: string): Promise<ChunkOverrideInfo[]> {
  const cfg = activeConfig();
  let pieces: {
    source_chunk_id: string;
    model: string;
    kind: string;
    token_start: number | null;
    token_end: number | null;
  }[];
  try {
    pieces = await sql<typeof pieces>`
      select source_chunk_id, model, kind, token_start, token_end
      from config_chunk_overrides
      where config_id = ${cfg.id}
      order by source_chunk_id, piece_index
    `;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
  if (pieces.length === 0) return [];

  const byChunk = new Map<string, typeof pieces>();
  for (const p of pieces) {
    const list = byChunk.get(p.source_chunk_id) ?? [];
    list.push(p);
    byChunk.set(p.source_chunk_id, list);
  }

  // Hover data: latest applied-override outcome per (question, metric) across
  // this config's autotune runs, grouped under the question's chunk.
  const outcomesByChunk = new Map<string, OverrideOutcome[]>();
  try {
    const rows = await sql<
      {
        source_chunk_id: string;
        question: string;
        difficulty: string | null;
        metric: string;
        before_value: number | null;
        before_rank: number | null;
        after_value: number | null;
        after_rank: number | null;
      }[]
    >`
      select distinct on (o.eval_question_id, o.metric)
        o.source_chunk_id, q.question, q.difficulty, o.metric,
        o.before_value, o.before_rank, o.after_value, o.after_rank
      from autotune_question_outcomes o
      join autotune_runs r on r.id = o.autotune_run_id
      join eval_questions q on q.id = o.eval_question_id
      where r.config_id = ${cfg.id} and o.override_kind is not null
      order by o.eval_question_id, o.metric, r.created_at desc
    `;
    for (const r of rows) {
      const list = outcomesByChunk.get(r.source_chunk_id) ?? [];
      list.push({
        question: r.question,
        difficulty: r.difficulty,
        metric: r.metric,
        beforeValue: r.before_value,
        beforeRank: r.before_rank,
        afterValue: r.after_value,
        afterRank: r.after_rank,
      });
      outcomesByChunk.set(r.source_chunk_id, list);
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "42P01") throw err;
  }

  const out: ChunkOverrideInfo[] = [];
  for (const [chunkId, chunkPieces] of byChunk) {
    const spanned = chunkPieces.filter(
      (p) => p.token_start !== null && p.token_end !== null,
    );
    let hasGap = false;
    if (spanned.length > 0) {
      const [chunk] = await sql<{ text: string }[]>`
        select text from ${sql(table)} where id = ${chunkId} limit 1
      `;
      if (chunk) {
        const { tokenCount } = await tokenizeWithOffsets(chunk.text);
        const spans = spanned
          .map((p) => ({ start: p.token_start!, end: p.token_end! }))
          .sort((a, b) => a.start - b.start);
        let covered = 0; // end of the contiguous covered prefix
        for (const s of spans) {
          if (s.start > covered) break; // hole before this span
          covered = Math.max(covered, s.end);
        }
        hasGap =
          spans[0].start > 0 ||
          covered < tokenCount ||
          // Unspanned pieces alongside spanned ones can't prove coverage.
          spanned.length < chunkPieces.length;
      }
    }
    out.push({
      chunkId,
      kind: chunkPieces[0].kind as OverrideKind,
      model: chunkPieces[0].model,
      pieceCount: chunkPieces.length,
      hasGap,
      outcomes: outcomesByChunk.get(chunkId) ?? [],
    });
  }
  return out;
}

export async function getSummary(): Promise<EvalSummary> {
  const cfg = activeConfig();
  const criteria = await getActiveCriteria();
  const recallK = effectiveK(criteria.recall, cfg.topK);
  const ndcgK = effectiveK(criteria.ndcg, cfg.topK);
  const configInfo: EvalConfigInfo = {
    id: cfg.id,
    corpusId: cfg.corpusId,
    baseModel: cfg.embeddingModel,
    chunkSize: cfg.chunkSize,
    chunkOverlap: cfg.chunkOverlap,
    topK: cfg.topK,
  };

  const empty: EvalSummary = {
    k: recallK,
    recallK,
    ndcgK,
    total: 0,
    scored: 0,
    hits: 0,
    recall: null,
    mrr: null,
    ndcg: null,
    ndcgCovered: 0,
    perDocument: [],
    questions: [],
    runs: [],
    pendingChunks: 0,
    pendingScoring: 0,
    retrievalStale: 0,
    retrievalChanges: [],
    chunkCount: 0,
    criteria,
    config: configInfo,
    overrides: [],
  };

  const table = await activeChunksTable();
  if (!table) return empty;

  // Fetched first: the detail query below prefers results scored under the
  // CURRENT override state, so it needs the fingerprint as a parameter.
  const currentState = await retrievalStateFingerprint();

  const [
    detail,
    runRows,
    pendingChunkRows,
    chunkCountRows,
    overrides,
    retrievalChangedAt,
    changeLog,
  ] = await Promise.all([
    sql<
      {
        question_id: string;
        question: string;
        source: string;
        difficulty: string | null;
        document_id: string;
        updated_at: Date;
        file_name: string;
        source_chunk_id: string;
        expected_position: number | null;
        hit: boolean | null;
        found_rank: number | null;
        retrieved_ids: string[] | null;
        retrieved_scores: number[] | null;
        scored_at: Date | null;
        retrieval_state: string | null;
        ignored: boolean;
      }[]
    >`
      with active_labels as (
        select l.id as label_id, l.eval_question_id, l.source_chunk_id
        from eval_labels l
        join document_embeddings de on de.id = l.document_embedding_id
        where de.config_id = ${activeConfig().id}
      ),
      latest as (
        -- The newest result scored under the CURRENT override state (0022),
        -- falling back to the newest overall (shown stale) when none matches.
        -- So reverting a delegate resurrects the pre-delegate results instead
        -- of leaving the chunk stale until a redundant re-score.
        select distinct on (r.eval_question_id)
          r.eval_question_id, r.hit, r.found_rank, r.retrieved_ids,
          r.retrieved_scores, r.scored_at, r.retrieval_state
        from eval_results r
        join active_labels al on al.label_id = r.eval_label_id
        order by r.eval_question_id,
          (r.retrieval_state is not distinct from ${currentState}) desc,
          r.scored_at desc
      )
      select
        q.id as question_id,
        q.question,
        q.source,
        q.difficulty,
        q.document_id,
        q.updated_at,
        d.file_name,
        al.source_chunk_id,
        c.position as expected_position,
        lt.hit,
        lt.found_rank,
        lt.retrieved_ids,
        lt.retrieved_scores,
        lt.scored_at,
        lt.retrieval_state,
        (ig.eval_question_id is not null) as ignored
      from eval_questions q
      join active_labels al on al.eval_question_id = q.id
      join documents d on d.id = q.document_id
      left join ${sql(table)} c on c.id = al.source_chunk_id
      left join latest lt on lt.eval_question_id = q.id
      left join config_question_ignores ig
        on ig.eval_question_id = q.id and ig.config_id = ${activeConfig().id}
      -- Document order so questions group cleanly by chunk on /eval; within a
      -- chunk, oldest first (generated, then any manual additions).
      order by d.file_name, c.position, q.created_at
    `,
    sql<
      {
        id: string;
        k: number;
        question_count: number;
        hit_count: number;
        mrr: number | null;
        ndcg: number | null;
        created_at: Date;
      }[]
    >`
      select id, k, question_count, hit_count, mrr, ndcg, created_at
      from eval_runs
      where config_id = ${activeConfig().id}
      order by created_at desc
      limit 20
    `,
    // Count of chunks under the active config missing a question for at least one
    // SELECTED difficulty — the generation half of "Process new chunks" (Phase A).
    // Mirrors chunksNeedingQuestionsByDifficulty; 0 when no difficulty is selected
    // (the cross join over an empty array yields no rows).
    sql<{ n: number }[]>`
      select count(distinct c.id)::int as n
      from ${sql(table)} c
      join document_embeddings de on de.id = c.document_embedding_id
      cross join unnest(${criteria.difficulties}::text[]) as d(difficulty)
      where de.config_id = ${activeConfig().id}
        and not exists (
          select 1
          from eval_labels l
          join eval_questions q on q.id = l.eval_question_id
          where l.source_chunk_id = c.id
            and l.document_embedding_id = c.document_embedding_id
            and q.difficulty = d.difficulty
        )
    `,
    sql<{ n: number }[]>`
      select count(c.id)::int as n
      from ${sql(table)} c
      join document_embeddings de on de.id = c.document_embedding_id
      where de.config_id = ${activeConfig().id}
    `,
    listChunkOverrideInfo(table),
    getRetrievalChangedAt(),
    listRetrievalChanges(),
  ]);

  // Each question's official (is_truth) ideal ranking, if any — what its graded
  // nDCG scores against. One query for all questions.
  const truthOrders = await getTruthOrder(detail.map((r) => r.question_id));

  // Results scored before the last retrieval-shape change (override/delegate set
  // or cleared) were produced by a retrieval that no longer exists. They still
  // COUNT toward the rates (badged stale, refreshed next run) — only edit-stale
  // rows are excluded, since their score belongs to the question's OLD text.
  let retrievalStale = 0;
  const editStaleIds = new Set<string>();
  const questions: QuestionDetail[] = detail.map((r) => {
    // Edited after its last score -> the shown hit/miss is for the old text. Treat
    // as pending (it will be re-scored next run, see questionsNeedingScoring).
    const editStale = r.scored_at !== null && r.updated_at.getTime() > r.scored_at.getTime();
    if (editStale) editStaleIds.add(r.question_id);
    // Retrieval-stale = scored under a DIFFERENT override state than today's
    // (0022 fingerprint), so a set-then-reverted change isn't stale. Legacy
    // rows without a fingerprint fall back to the 0019 timestamp rule.
    const retrStale =
      r.scored_at !== null &&
      (r.retrieval_state !== null
        ? r.retrieval_state !== currentState
        : retrievalChangedAt !== null &&
          r.scored_at.getTime() < retrievalChangedAt.getTime());
    if (retrStale && !editStale) retrievalStale += 1;
    const stale = editStale || retrStale;
    const scored = r.scored_at !== null;
    // Recompute the hit at the CURRENT recall_k from the stored found_rank (the
    // rank within the stored superset, A1) — so changing recall_k in Settings is
    // reflected without a re-score, as long as it's within the retrieved depth.
    const hit = scored ? r.found_rank !== null && r.found_rank <= recallK : null;
    const countable = scored && !editStale;
    // Graded nDCG needs an ideal ranking AND a countable retrieval order;
    // otherwise it's ungraded (null) and the UI shows the grey placeholder.
    const ideal = truthOrders.get(r.question_id);
    const qNdcg = countable && ideal ? ndcg(ideal, r.retrieved_ids ?? [], ndcgK) : null;
    // The ground-truth chunk's cosine sim in the stored retrieval — found_rank is
    // 1-based into retrieved_scores. Null on a full miss or pre-0004 results.
    const storedSim =
      countable && r.found_rank !== null && r.retrieved_scores
        ? (r.retrieved_scores[r.found_rank - 1] ?? null)
        : null;
    return {
      questionId: r.question_id,
      question: r.question,
      source: r.source,
      difficulty: r.difficulty,
      documentId: r.document_id,
      fileName: r.file_name,
      sourceChunkId: r.source_chunk_id,
      expectedPosition: r.expected_position,
      hit,
      foundRank: r.found_rank,
      storedSim,
      retrievedIds: r.retrieved_ids,
      scoredAt: r.scored_at ? r.scored_at.getTime() : null,
      stale,
      editStale,
      ndcg: qNdcg,
      ignored: r.ignored,
    };
  });

  // Scored rows count toward recall — including retrieval-stale ones (badged,
  // approximate until the next run). Unscored and edit-stale are pending, and
  // ignored questions are excluded from every rate (§7) — they still render.
  const scoredRows = questions.filter(
    (q) => q.hit !== null && !editStaleIds.has(q.questionId) && !q.ignored,
  );
  const hits = scoredRows.filter((q) => q.hit === true).length;

  // MRR over the same scored set, straight from found_rank (single-relevant) —
  // no extra retrieval, so already-scored questions are covered retroactively.
  const mrr =
    scoredRows.length > 0
      ? scoredRows.reduce((sum, q) => sum + reciprocalRank(q.foundRank), 0) /
        scoredRows.length
      : null;

  // Mean graded nDCG over exactly the questions that have one (ranked + freshly
  // scored, not ignored). ndcgCovered is that set's size — the dashboard's 5/n.
  const graded = questions
    .filter((q) => !q.ignored)
    .map((q) => q.ndcg)
    .filter((v): v is number => v !== null);
  const ndcgValue =
    graded.length > 0 ? graded.reduce((sum, v) => sum + v, 0) / graded.length : null;
  const ndcgCovered = graded.length;

  // Questions "Process new chunks" would score: never scored, or edited since.
  // Matches questionsNeedingScoring() — no extra query needed.
  const pendingScoring = questions.filter((q) => q.hit === null || q.stale).length;

  // Maintenance sweep: when nothing is retrieval-stale anymore but change-log
  // entries linger (a revert restored the fingerprint, netting them out), drop
  // them so the next real change starts a clean history. Best-effort.
  if (retrievalStale === 0 && changeLog.length > 0) {
    await clearRetrievalChanges().catch(() => {});
  }

  const byDoc = new Map<string, DocumentBreakdown>();
  for (const q of questions) {
    let d = byDoc.get(q.documentId);
    if (!d) {
      d = { documentId: q.documentId, fileName: q.fileName, scored: 0, hits: 0 };
      byDoc.set(q.documentId, d);
    }
    // Same inclusion rule as the headline rates: retrieval-stale counts.
    if (q.hit !== null && !editStaleIds.has(q.questionId) && !q.ignored) {
      d.scored += 1;
      if (q.hit) d.hits += 1;
    }
  }

  return {
    k: recallK,
    recallK,
    ndcgK,
    total: questions.length,
    scored: scoredRows.length,
    hits,
    recall: scoredRows.length > 0 ? hits / scoredRows.length : null,
    mrr,
    ndcg: ndcgValue,
    ndcgCovered,
    perDocument: [...byDoc.values()],
    questions,
    runs: runRows.map((r) => ({
      id: r.id,
      k: r.k,
      questionCount: r.question_count,
      hitCount: r.hit_count,
      mrr: r.mrr,
      ndcg: r.ndcg,
      createdAt: r.created_at.getTime(),
    })),
    pendingChunks: pendingChunkRows[0]?.n ?? 0,
    pendingScoring,
    retrievalStale,
    // Log entries can outlive their stale rows (e.g. a scoped re-score covered
    // them all) — hide the history once nothing is actually stale.
    retrievalChanges:
      retrievalStale > 0
        ? changeLog.map((c) => ({ description: c.description, at: c.at.getTime() }))
        : [],
    chunkCount: chunkCountRows[0]?.n ?? 0,
    criteria,
    config: configInfo,
    overrides,
  };
}
