// DB layer for retrieval evals (Recall@k). Mirrors vectorStore.ts: raw SQL, no
// business logic — orchestration lives in eval.ts.
//
// Everything here is scoped to the ACTIVE config via de.config_id. Questions are
// document-scoped; their ground-truth chunk for a given config lives in
// eval_labels, so the same question can later be scored against other configs
// without re-authoring.
import { activeUserId } from "@/lib/auth/userScope";
import { sql, toJsonb } from "@/lib/db";
import { FROZEN_REASON, PUBLISHED_RUN_NOTE } from "@/lib/demo/frozen";
import { isGuest } from "@/lib/demo/guest";
import { readBoard, readIdeals, readLlmRankings } from "@/lib/demo/replay";
import {
  demoBlockedSentences,
  EVAL_DEMO_ACTIONS,
  type DemoBlockedSentences,
} from "@/lib/demo/policy";
import { activeConfig, isUuid } from "@/lib/rag/activeConfig";
import { cacheKey, DigestMemo } from "@/lib/rag/digestMemo";
import { reciprocalRank, ndcg } from "@/lib/rag/evalMetrics";
import { reduceRates } from "@/lib/rag/evalRates";
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
import {
  getTruthOrder,
  truthKindByQuestion,
  type RankingKind,
} from "@/lib/rag/rankingStore";
import type { ScreenCutoffs } from "@/lib/rag/retriever";

// Human labels for a ground-truth ranking's kind — mirrors the per-question
// panel's KIND_LABEL, used in the drift badge's "stuck truth" callout.
const TRUTH_KIND_LABEL: Record<RankingKind, string> = {
  aggregate: "Embedding aggregate",
  llm_pool: "LLM · ranked pool",
  llm_rerank: "LLM · re-ranked top-k",
  manual: "Manual",
};

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
  // Per retrievedIds entry, same order: the chunk's cosine similarity in its
  // canonical space (base model, or its delegate model on the fused path — so
  // not necessarily descending, the stored order is authoritative).
  retrievedScores: number[];
  // Fingerprint of the override state this was scored under (0022) — stale iff
  // it differs from the current retrievalStateFingerprint().
  retrievalState: string;
  // Similarity cutoffs this retrieval was judged at (0028) — lets the
  // post-autotune dirty screen prove the result unaffected by an override
  // change without re-retrieving. See retriever.ScreenCutoffs.
  screenCutoffs: ScreenCutoffs | null;
  // A shadow measurement of the same question with no overrides in effect
  // (0057), for the baseline ticker. NEVER a live result: every "latest result"
  // read filters these out. Defaults to false.
  isBaseline?: boolean;
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
  // Reciprocal rank at mrr_k (1/found_rank, 0 when it landed past mrr_k or
  // missed entirely); null when unscored. Feeds the MRR aggregate and the
  // min-rate bar the same way `hit` feeds recall and `ndcg` feeds nDCG.
  rr: number | null;
  // Graded nDCG@k against this question's official ideal ranking; null when it
  // has no ranking yet or no fresh score (ungraded → grey chip on /eval).
  ndcg: number | null;
  // "Ignore in rates" (§7): still rendered (greyed) but excluded from the
  // Recall/nDCG aggregates, the min-rate pass/fail counts, and autotune targeting.
  ignored: boolean;
  // The subset of `ignored` that is there by the holdout draw (0061) rather than
  // by a human's click. Held-out questions ARE scored — `hit`, `foundRank`, `rr`
  // and `ndcg` are all populated — so the generalization number is computed from
  // these rows; it can never be read off the dashboard summary, which excludes
  // them by design.
  heldOut: boolean;
  // The other subset of `ignored`: frozen by a demo publish (lib/demo/frozen)
  // rather than by anybody's decision about the question. A guest's workbench is
  // twelve live questions and ~460 frozen ones, and the difference has to be
  // visible — "ignored" on a question nobody ignored reads as a judgement the
  // demo never made. Always false for a real account, which has no such rows.
  frozen: boolean;
};

// One autotune-run outcome row for the yellow ◷ hover (§6.4): a question's
// per-metric before → after under the chunk's applied override.
export type OverrideOutcome = {
  questionId: string;
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
  // How many of `questionCount` the nDCG mean covers — questions that had an
  // is_truth ranking when the run was taken (0076). Null on rows written before
  // it, where the denominator was never recorded and cannot be reconstructed.
  ndcgCovered: number | null;
  createdAt: number;
  // Free-text label on the run. Written by exactly two things today: nothing (the
  // ordinary snapshot path leaves it null) and a demo publish, whose single row
  // carries PUBLISHED_RUN_NOTE and is found by it. Carried on the type so
  // `asPublished` can identify that row without a second query.
  notes: string | null;
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

// One chunk under the active config, with just enough to head a dashboard card.
// Deliberately not the chunk TEXT: the summary already carries every question,
// and a corpus's full text would dwarf the rest of the payload.
export type ChunkRef = {
  chunkId: string;
  fileName: string;
  position: number | null;
};

// The baseline comparison behind the dashboard tickers (0057).
//
// BOTH SIDES ARE MEASURED OVER THE SAME QUESTIONS. A baseline fills in
// opportunistically, so it is often partial — and a delta between a 120-question
// live number and an 84-question baseline compares two different question sets
// and means nothing. `questions` is the comparable subset's size, and the live
// figures here are that subset's, NOT the headline ones.
export type EvalBaseline = {
  questions: number; // comparable subset size — what "vs baseline, n questions" reports
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
  liveRecall: number | null;
  liveMrr: number | null;
  liveNdcg: number | null;
};

export type EvalSummary = {
  // `k` stays = recallK for back-compat (run progress / explain). recallK,
  // mrrK, and ndcgK are the effective per-metric depths (A1).
  k: number;
  recallK: number;
  mrrK: number;
  ndcgK: number;
  total: number; // questions with a label under the active config
  scored: number; // of those, how many have a result
  hits: number;
  recall: number | null; // hits / scored
  // Mean reciprocal rank AT mrr_k over the same fresh-scored set as recall
  // (a landing past mrr_k contributes 0); null when nothing is scored.
  mrr: number | null;
  // Mean graded nDCG@k (see lib/rag/evalMetrics.ndcg) over only the questions
  // that have an official ideal ranking AND a fresh score; null when none do.
  ndcg: number | null;
  // How many questions feed that nDCG average — the "5" in the dashboard's 5/n
  // (n = total). Questions without a ground-truth ranking aren't graded.
  ndcgCovered: number;
  // nDCG corpus-drift signal. Documents that entered this config AFTER a graded
  // question's ideal was built and/or after it was scored: their chunks were never
  // candidates for the ideals, yet retrieval now competes them in, so this nDCG can
  // understate quality. All zero/false = the number reflects the corpus.
  ndcgStaleDocs: number;
  ndcgStaleRescore: boolean; // some graded question was scored before a doc arrived
  ndcgStaleRebuild: boolean; // some AGGREGATE ideal predates a doc — bulk rebuild fixes it
  // Graded questions whose ideal predates a newer document AND whose ground
  // truth is a manual/LLM ranking (not the aggregate). The bulk rebuild leaves
  // these alone, so they keep the badge lit until hand-fixed — named here (by
  // labeled chunk + kind) so the tooltip can point at them. Empty when none.
  ndcgStuckTruths: { chunk: string; kind: string }[];
  // What the per-chunk tuning has bought (0057). Null when the config has no
  // overrides — live IS baseline then, so there is no delta to show — and null
  // when no question has a usable baseline measurement yet.
  baseline: EvalBaseline | null;
  perDocument: DocumentBreakdown[];
  questions: QuestionDetail[];
  runs: RunSnapshot[];
  // THE DEMO'S FROZEN HEADLINE — non-null only for a guest, and only once a build
  // has been published (scripts/demo-snapshot.ts writes exactly one eval_runs row).
  //
  // A guest's workspace is a copy of a published build, so the ordinary aggregates
  // above are "what the numbers are NOW, after whatever you have done to them" and
  // this is "what they were when this demo was published". The Eval tab shows both,
  // which is the only way a visitor can tell their own tuning apart from the corpus.
  //
  // Deliberately NOT called `baseline`: that name is taken twice over in this file
  // already — 0057's no-overrides shadow leg (the `baseline` field above) and
  // 0074's holdout split. This is a third and different thing.
  asPublished: RunSnapshot | null;
  // How many autotune runs of this config recorded a held-out set (0074). The
  // gate for the /eval "Held-out set" section, which must not appear at all for a
  // config that has never taken the measurement — and must appear for one whose
  // holdout is off NOW but has history worth reconciling. A count rather than a
  // boolean because it is free either way and "0 of them" is a more useful thing
  // for a caller to be able to say.
  holdoutRuns: number;
  // pendingScoring: questions never scored or edited since last score — the
  // work "Score pending" would do, so the UI can disable the button when
  // there's nothing pending. pendingChunks: chunks below the per-chunk question
  // target at a difficulty this config has used. Reporting only since generation
  // left that button — nothing gates on it.
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
  // = nothing to generate against). Always equals `chunks.length`, which for a
  // demo guest is the BOARD's size rather than the corpus's (see demoBoard): the
  // corpus is still 236 chunks and retrieval still ranks against all of them,
  // but the workbench lists the ~30 a visitor walks.
  chunkCount: number;
  // EVERY chunk under the active config, in document order — not just the ones
  // that have questions. The dashboard groups questions by chunk, and seeding
  // those groups from this list is what lets a freshly ingested document show up
  // straight away: you get a card per chunk with the "add question" and "try a
  // model" affordances on it, before any question exists to hang them off.
  chunks: ChunkRef[];
  // WHAT THIS VISITOR MAY NOT PRESS — action name to the sentence explaining it,
  // and null for everyone but a guest (lib/demo/policy.demoBlockedSentences).
  //
  // The gate itself is still the boundary; this is what lets the page render a
  // blocked control DISABLED instead of leaving it looking live until a 403 comes
  // back from three layers down. Confirmed 2026-08-29 that every one of them did.
  demoBlocked: DemoBlockedSentences | null;
  // WHICH CHUNKS THE DEMO'S BOARD IS, and null for everyone but a guest whose
  // build published one (0081, lib/demo/replay.readBoard).
  //
  // It is what the frozen set used to imply. The dashboard's split — "Chunks
  // (12)" over a "Frozen — 448" section — is derived from `frozenCount > 0`
  // today, which is a scope that evaporates the moment the board is emptied for
  // the visitor to build it themselves (docs/demo-real-flow-plan.md §3.1). So the
  // scope is handed over as data instead of inferred, and `chunks` above is
  // already filtered to it: a guest's payload carries the board, not the corpus.
  //
  // Null for a real account means every derivation downstream falls back to
  // exactly what it does today, by construction rather than by a branch.
  demoBoard: string[] | null;
  // The saved eval criteria (metrics/k/min-rate/difficulties/autotune) and the
  // active config basics — for the Settings dropdown and Bulk-actions pre-fill.
  criteria: EvalCriteria;
  config: EvalConfigInfo;
  // Active per-chunk overrides (Phase D badges) — empty when none.
  overrides: ChunkOverrideInfo[];
};

// The vector space a result was measured in (0057): the config's SELECTED
// embedding model and chunk shape. Baseline rows are only comparable to live rows
// carrying the same key — change either and the old baseline is measuring
// something else, so it stops matching and is re-run.
//
// Deliberately excludes overrides: they're what the baseline is defined as the
// absence of, and the 0022 fingerprint already tracks them.
export function baselineKey(): string {
  const cfg = activeConfig();
  return `${cfg.embeddingModel}|${cfg.chunkSize}|${cfg.chunkOverlap}`;
}

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

// One page of chunks for an outside author (the MCP `list_chunks` tool): the
// passage plus enough context to write a question about it and enough counting to
// know which chunks still need one.
export type ChunkPageRow = {
  chunkId: string;
  documentId: string;
  fileName: string;
  position: number | null;
  text: string;
  questionCount: number;
  // Total chunks in scope, repeated on every row by the window function. The
  // caller reads it off row zero to report progress; an empty page has no total
  // and reports zero, which is also the truth.
  total: number;
};

// A stable-ordered page of the active config's chunks. Ordered by document then
// position rather than by id because paging is only coherent if the order is:
// two calls with different offsets have to be windows onto ONE list, and c.id is
// a uuid, which orders by nothing a reader would recognise.
export async function listChunkPage(
  offset: number,
  limit: number,
  documentId?: string,
): Promise<ChunkPageRow[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  const docScope = documentId && isUuid(documentId) ? documentId : null;

  const rows = await sql<
    {
      id: string;
      document_id: string;
      file_name: string;
      position: number | null;
      text: string;
      question_count: number;
      total: number;
    }[]
  >`
    select c.id, c.document_id, doc.file_name, c.position, c.text,
           e.have as question_count,
           count(*) over()::int as total
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    join documents doc on doc.id = c.document_id
    cross join lateral (
      select count(*)::int as have
      from eval_labels l
      where l.source_chunk_id = c.id
        and l.document_embedding_id = c.document_embedding_id
    ) e
    where de.config_id = ${activeConfig().id}
      and (${docScope}::uuid is null or c.document_id = ${docScope}::uuid)
    order by doc.file_name, c.position, c.id
    offset ${offset} limit ${limit}
  `;

  return rows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    fileName: r.file_name,
    position: r.position,
    text: r.text,
    questionCount: r.question_count,
    total: r.total,
  }));
}

// Resolve MANY chunk ids to the document + embedding run their label must name,
// in one query. Same resolution as addManualQuestion and getChunkForGeneration —
// and the same refusal: an id belonging to another config (or to nothing) simply
// isn't in the returned map, so the caller reports it per item rather than
// failing a whole batch over one bad id.
export async function resolveChunksForLabeling(
  chunkIds: string[],
): Promise<Map<string, { documentId: string; documentEmbeddingId: string }>> {
  const resolved = new Map<string, { documentId: string; documentEmbeddingId: string }>();
  const ids = chunkIds.filter(isUuid);
  if (ids.length === 0) return resolved;

  const table = await activeChunksTable();
  if (!table) return resolved;

  const rows = await sql<
    { id: string; document_id: string; document_embedding_id: string }[]
  >`
    select c.id, c.document_id, c.document_embedding_id
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    where c.id = any(${ids}::uuid[])
      and de.config_id = ${activeConfig().id}
  `;
  for (const r of rows) {
    resolved.set(r.id, {
      documentId: r.document_id,
      documentEmbeddingId: r.document_embedding_id,
    });
  }
  return resolved;
}

// A chunk in scope together with the questions it ALREADY shows under the active
// config — the shape the question cache needs to top a chunk up from the bank
// without asking for a difficulty or a count.
export type ChunkWithQuestions = {
  chunkId: string;
  text: string;
  documentId: string;
  documentEmbeddingId: string;
  fileName: string;
  position: number | null;
  // Every question text currently labeled to this chunk, whatever its difficulty
  // and whoever wrote it (generated, reused, or hand-added). The dedupe compares
  // against this, so a hand-written question blocks its banked twin too.
  existingQuestions: string[];
};

// Every chunk under the active config (optionally narrowed to some documents),
// carrying the question texts it already holds. Unlike
// chunksNeedingQuestionsByDifficulty this filters NOTHING: "Add cached" tops a
// chunk up with whatever the bank holds for its exact text, so the caller needs
// every chunk and every existing question to compare against.
export async function chunksWithQuestions(
  documentIds?: string[],
): Promise<ChunkWithQuestions[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  const docScope = documentIds && documentIds.length > 0 ? documentIds : null;

  const rows = await sql<
    {
      id: string;
      text: string;
      document_id: string;
      document_embedding_id: string;
      file_name: string;
      position: number | null;
      existing: string[];
    }[]
  >`
    select c.id, c.text, c.document_id, c.document_embedding_id,
           doc.file_name, c.position,
           coalesce(
             array_agg(q.question) filter (where q.question is not null),
             '{}'
           ) as existing
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    join documents doc on doc.id = c.document_id
    left join eval_labels l
      on l.source_chunk_id = c.id
     and l.document_embedding_id = c.document_embedding_id
    left join eval_questions q on q.id = l.eval_question_id
    where de.config_id = ${activeConfig().id}
      and (${docScope}::uuid[] is null or c.document_id = any(${docScope}::uuid[]))
    group by c.id, c.text, c.document_id, c.document_embedding_id,
             doc.file_name, c.position
    order by c.position
  `;

  return rows.map((r) => ({
    chunkId: r.id,
    text: r.text,
    documentId: r.document_id,
    documentEmbeddingId: r.document_embedding_id,
    fileName: r.file_name,
    position: r.position,
    existingQuestions: r.existing,
  }));
}

// One (chunk, difficulty) generation gap: a chunk under the active config that
// is short of the requested number of questions at `difficulty`. Drives the
// difficulty-driven generator (Phase A) — generation is "N questions per
// selected difficulty per chunk" (N defaults to 1) instead of a fixed per-chunk
// count across all difficulties.
export type ChunkDifficultyGap = {
  chunkId: string;
  text: string;
  documentId: string;
  documentEmbeddingId: string;
  difficulty: string;
  // How many questions to generate for this chunk at this difficulty. In top-up
  // mode that's the requested target minus what the chunk already has (always
  // >= 1 — rows at target are dropped); in absolute mode it's the requested
  // count flat, whatever the chunk already holds.
  needed: number;
  // What the chunk already has at this difficulty, as of the query. The batch
  // path adds `needed` to it for the ceiling its idempotency guard re-checks
  // against — the only way absolute mode can express "N MORE than these".
  have: number;
  // For the live "question landed" stream event: where the dashboard should
  // file the new row (its chunk group header) without waiting for a reload.
  fileName: string;
  position: number | null;
};

// The generation gaps for each requested difficulty, in one of two modes.
//
// `topUp`: chunks with fewer than `targets[i]` questions at that difficulty, each
// needing the difference — "fill every chunk to 2 easy", so a second click costs
// nothing.
//
// Absolute (the default): EVERY chunk in scope, each needing `targets[i]` flat —
// "add 2 more easy to every chunk", so a second click buys two more again.
//
// One query either way; only the `needed` expression and the drop-at-target
// filter differ.
export async function chunksNeedingQuestionsByDifficulty(
  difficulties: string[],
  documentIds?: string[],
  targets?: number[],
  topUp = false,
): Promise<ChunkDifficultyGap[]> {
  const table = await activeChunksTable();
  if (!table || difficulties.length === 0) return [];
  // Bulk-actions scope: one or more documents; null/empty = the whole corpus.
  const docScope = documentIds && documentIds.length > 0 ? documentIds : null;
  // Aligned with `difficulties`; a missing/short list means one each.
  const wanted = difficulties.map((_, i) => Math.max(1, Math.trunc(targets?.[i] ?? 1)));

  const rows = await sql<
    {
      id: string;
      text: string;
      document_id: string;
      document_embedding_id: string;
      difficulty: string;
      needed: number;
      have: number;
      file_name: string;
      position: number | null;
    }[]
  >`
    select c.id, c.text, c.document_id, c.document_embedding_id, d.difficulty,
           (case when ${topUp}::boolean then d.target - e.have else d.target end)::int as needed,
           e.have,
           doc.file_name, c.position
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    join documents doc on doc.id = c.document_id
    cross join unnest(${difficulties}::text[], ${wanted}::int[]) as d(difficulty, target)
    cross join lateral (
      select count(*)::int as have
      from eval_labels l
      join eval_questions q on q.id = l.eval_question_id
      where l.source_chunk_id = c.id
        and l.document_embedding_id = c.document_embedding_id
        and q.difficulty = d.difficulty
    ) e
    where de.config_id = ${activeConfig().id}
      and (${docScope}::uuid[] is null or c.document_id = any(${docScope}::uuid[]))
      and (not ${topUp}::boolean or e.have < d.target)
    order by c.position, d.difficulty
  `;

  return rows.map((r) => ({
    chunkId: r.id,
    text: r.text,
    documentId: r.document_id,
    documentEmbeddingId: r.document_embedding_id,
    difficulty: r.difficulty,
    needed: r.needed,
    have: r.have,
    fileName: r.file_name,
    position: r.position,
  }));
}

// Insert one question (document-scoped) plus its ground-truth label for the
// given config, atomically. Used by both generated questions (source='generated',
// generatorModel set) and manual additions (source='manual', generatorModel null).
// Returns the new question's id so the bulk generator can stream it to the
// dashboard (and the later score-result event can reference the same row).
export async function insertQuestionWithLabel(args: {
  documentId: string;
  documentEmbeddingId: string;
  sourceChunkId: string;
  question: string;
  expectedAnswer: string | null;
  source?: "generated" | "manual";
  generatorModel: string | null;
  difficulty?: string | null; // graded synthetic only; null for manual / default-generated
}): Promise<string> {
  const source = args.source ?? "generated";
  return sql.begin(async (tx) => {
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
    return q.id;
  });
}

// Add a hand-written question labeled to a specific chunk under the active config.
// Resolves the chunk to its document + embedding-run so the label is correct, then
// inserts as a 'manual' question. Returns false when the chunk isn't part of the
// active config's corpus (stale id, wrong config). Scoring happens on the next
// "Score pending" / "Re-score all" like any other unscored question.
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

// THE DEMO'S SCOPE, AS A WHERE CLAUSE — the one place scoring is narrowed to the
// questions a guest is allowed to move (docs/demo-analytics-plan.md, phase 4).
//
// Frozen questions are still SCORED rows: their published result is what the Eval
// tab shows and what the "As published" card averages. What they are not is work
// that a re-score, a "Score pending" or an override's dirty screen may redo —
// each of those retrieves a top-k of chunk TEXT per question, and ~460 of them is
// the megabytes this demo's egress budget does not have. Twelve is ~150 KB.
//
// NOT an isGuest() branch. It filters on a marker the publish wrote (see
// lib/demo/frozen), so a real account — which has no frozen rows — takes exactly
// the query it took before, and nothing about the store layer's behaviour depends
// on who is asking.
//
// Both call sites, deliberately: allLabeledQuestions is "re-score all" and
// questionsNeedingScoring is "score pending", and a scope that covered one of
// them would just move the whole cost onto the other button.
const notFrozen = () => sql`
  and not exists (
    select 1 from config_question_ignores ig
     where ig.config_id = ${activeConfig().id}
       and ig.eval_question_id = q.id
       and ig.reason = ${FROZEN_REASON}
  )`;

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
      ${notFrozen()}
      and not exists (
        select 1 from eval_results r
        where r.eval_label_id = l.id
          -- Shadow baseline rows (0057) are not scores of the retrieval the
          -- user is running: counting one here would leave the question
          -- permanently "already scored" and never really scored at all.
          and not r.is_baseline
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
// already has a fresh result. Backs "Re-score all", which keeps recall
// apples-to-apples after the corpus changes. questionsNeedingScoring() is the
// incremental counterpart used by "Score pending".
export async function allLabeledQuestions(
  documentIds?: string[],
): Promise<(QuestionToScore & { documentId: string })[]> {
  const docScope = documentIds && documentIds.length > 0 ? documentIds : null;
  const rows = await sql<
    {
      question_id: string;
      question: string;
      label_id: string;
      source_chunk_id: string;
      document_id: string;
    }[]
  >`
    select
      q.id as question_id,
      q.question,
      l.id as label_id,
      l.source_chunk_id,
      q.document_id
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${activeConfig().id}
      ${notFrozen()}
      and (${docScope}::uuid[] is null or q.document_id = any(${docScope}::uuid[]))
  `;

  return rows.map((r) => ({
    questionId: r.question_id,
    question: r.question,
    labelId: r.label_id,
    sourceChunkId: r.source_chunk_id,
    documentId: r.document_id,
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
// newest result matching the CURRENT state wins (falling back to newest overall),
// mirroring getSummary — so the drill-down always explains the same result the
// badge shows, including after a delegate revert.
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
      and not is_baseline
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
  // WHOLE corpus exactly (row_number, full scan — no HNSW), then return the chunks
  // between the top-k cut-off and it. Best-effort: stays null/empty if the vector
  // isn't cached, so the drill-down never breaks over it. Exact ranking means
  // rank <= k here would mean HNSW dropped a chunk it should have surfaced.
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

// One chunk's text, for the "chunk #N" toggle on a dashboard card header. Exists
// because reading a chunk's text used to be possible only through a question's
// explain drill-down, leaving a chunk with no questions unreadable.
//
// Config-scoped through document_embeddings, so a chunk id belonging to another
// config reads as missing rather than as someone else's text. RLS already hides
// other tenants; this covers the in-tenant, wrong-config case, which RLS says
// nothing about.
export async function getChunkText(
  chunkId: string,
): Promise<{ text: string; fileName: string; position: number | null } | null> {
  if (!isUuid(chunkId)) return null;
  const table = await activeChunksTable();
  if (!table) return null;
  const [row] = await sql<
    { text: string; file_name: string; position: number | null }[]
  >`
    select c.text, d.file_name, c.position
    from ${sql(table)} c
    join document_embeddings de on de.id = c.document_embedding_id
    join documents d on d.id = c.document_id
    where c.id = ${chunkId} and de.config_id = ${activeConfig().id}
    limit 1
  `;
  return row
    ? { text: row.text, fileName: row.file_name, position: row.position }
    : null;
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
  // The owning document's id, not just its name: nothing stops two documents
  // sharing a file name, and the picker groups on this so same-named uploads
  // stay separate groups.
  documentId: string;
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
  // Fused dry-run (see eval.runModelTrial): the merged position this chunk
  // would occupy under REAL rank-fused retrieval if the trial variation were
  // applied as its override — ranked against the base ANN's full candidate
  // list plus the config's other overrides, not just the test pool. The
  // honest promotion forecast. Optional: absent on trials saved before this.
  fusedRank?: number;
  fusedHit?: boolean;
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
// embedding under `model` (0020) — free trial-pool candidates. Hash must mirror
// lib/rag/embedCache (sha256 hex over the exact UTF-8 text). Cache table missing
// → none.
//
// "Already paid for" means BY THIS ACCOUNT since 0050 — the join carries its own
// user_id predicate. The config filter alone wouldn't supply it: the cache row is
// content-addressed and reached by text hash, so without it a chunk would count
// as free because a different tenant had embedded the same text.
export async function cachedChunkIdsForModel(model: string): Promise<string[]> {
  const table = await activeChunksTable();
  if (!table) return [];
  try {
    const rows = await sql<{ id: string }[]>`
      select c.id
      from ${sql(table)} c
      join document_embeddings de on de.id = c.document_embedding_id
      join embedding_cache ec
        on ec.user_id = ${activeUserId()}
       and ec.model = ${model}
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
      where not r.is_baseline
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
  // d.id in the ordering keeps two same-named documents from interleaving —
  // the client groups these rows by document and relies on each group's rows
  // being contiguous.
  const rows = await sql<
    {
      id: string;
      position: number | null;
      preview: string;
      document_id: string;
      file_name: string;
    }[]
  >`
    select c.id, c.position, left(c.text, 200) as preview, d.id as document_id, d.file_name
    from ${sql(table)} c
    join documents d on d.id = c.document_id
    join document_embeddings de on de.id = c.document_embedding_id
    where de.config_id = ${activeConfig().id}
      and not (c.id = any(${excludeIds}::uuid[]))
    order by d.file_name, d.id, c.position
  `;
  return rows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    fileName: r.file_name,
    position: r.position,
    preview: r.preview,
  }));
}

export type AutotuneScopeChunk = {
  chunkId: string;
  position: number | null;
  preview: string | null; // first chars of the chunk text, for the hover title
  questions: number; // labeled questions on this chunk
};
export type AutotuneScopeDocument = {
  documentId: string;
  fileName: string;
  chunks: AutotuneScopeChunk[];
};

// Every LABELED chunk under the active config, grouped by document — what the
// Settings dropdown's "Chunks" autotune-scope picker lists (0025). Only labeled
// chunks appear: a chunk without questions can never be an autotune target, so
// listing it would only be noise.
export async function listAutotuneScopeOptions(): Promise<AutotuneScopeDocument[]> {
  const table = await activeChunksTable();
  if (!table) return [];

  const rows = await sql<
    {
      document_id: string;
      file_name: string;
      source_chunk_id: string;
      position: number | null;
      preview: string | null;
      questions: number;
    }[]
  >`
    select
      d.id as document_id,
      d.file_name,
      l.source_chunk_id,
      c.position,
      left(c.text, 200) as preview,
      count(*)::int as questions
    from eval_labels l
    join document_embeddings de on de.id = l.document_embedding_id
    join eval_questions q on q.id = l.eval_question_id
    join documents d on d.id = q.document_id
    left join ${sql(table)} c on c.id = l.source_chunk_id
    where de.config_id = ${activeConfig().id}
    group by d.id, l.source_chunk_id, c.id
    order by d.file_name asc, c.position asc nulls last
  `;

  const docs = new Map<string, AutotuneScopeDocument>();
  for (const r of rows) {
    let doc = docs.get(r.document_id);
    if (!doc) {
      doc = { documentId: r.document_id, fileName: r.file_name, chunks: [] };
      docs.set(r.document_id, doc);
    }
    doc.chunks.push({
      chunkId: r.source_chunk_id,
      position: r.position,
      preview: r.preview,
      questions: r.questions,
    });
  }
  return [...docs.values()];
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

type ModelTrialRow = {
  id: string;
  source_chunk_id: string;
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
};

// Resolve every trial's pool to labels/text in ONE query regardless of how many
// trials came back, then map each id back in stored order. A stale id (config
// changed since save) gets a placeholder so the pool length still reflects what
// was saved. Shared by the single-chunk and whole-config reads below.
async function hydrateModelTrials(
  rows: ModelTrialRow[],
): Promise<SavedModelTrial[]> {
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

export async function listModelTrials(chunkId: string): Promise<SavedModelTrial[]> {
  const rows = await sql<ModelTrialRow[]>`
    select t.id, t.source_chunk_id, t.baseline_model, t.trial_model, t.kind,
           t.chunk_size, t.chunk_overlap, t.piece_count, t.k, t.pool_chunk_ids,
           t.question_count, t.hit_count, t.stored_hit_count, t.results,
           t.created_at
    from eval_model_trials t
    join document_embeddings de on de.id = t.document_embedding_id
    where t.source_chunk_id = ${chunkId}
      and de.config_id = ${activeConfig().id}
    order by t.created_at desc
  `;
  return hydrateModelTrials(rows);
}

// Every saved trial under the active config, grouped by source chunk. The
// dashboard renders one "Models tried" section per chunk group, so fetching them
// per chunk meant one request (and two queries) per group — 80 of them on a
// corpus this size, most returning nothing. This is the whole set in one.
export async function listModelTrialsByChunk(): Promise<
  Record<string, SavedModelTrial[]>
> {
  const rows = await sql<ModelTrialRow[]>`
    select t.id, t.source_chunk_id, t.baseline_model, t.trial_model, t.kind,
           t.chunk_size, t.chunk_overlap, t.piece_count, t.k, t.pool_chunk_ids,
           t.question_count, t.hit_count, t.stored_hit_count, t.results,
           t.created_at
    from eval_model_trials t
    join document_embeddings de on de.id = t.document_embedding_id
    where de.config_id = ${activeConfig().id}
    order by t.created_at desc
  `;
  const trials = await hydrateModelTrials(rows);

  // Same order as the per-chunk read (created_at desc) — rows come back sorted,
  // so pushing preserves it within each group.
  const byChunk: Record<string, SavedModelTrial[]> = {};
  rows.forEach((r, i) => {
    (byChunk[r.source_chunk_id] ??= []).push(trials[i]);
  });
  return byChunk;
}

// eval_model_trials carries no config_id (see 0011) — it reaches one through
// document_embedding_id, so that join IS the authorization check. Without it a
// guessed trial id deletes another config's (or another account's) saved trial.
export async function deleteModelTrial(id: string): Promise<boolean> {
  const rows = await sql`
    delete from eval_model_trials t
    using document_embeddings de
    where de.id = t.document_embedding_id
      and de.config_id = ${activeConfig().id}
      and t.id = ${id}
    returning t.id
  `;
  return rows.length > 0;
}

export async function insertResults(rows: ResultInsert[]): Promise<void> {
  if (rows.length === 0) return;
  // Stamped on live and baseline rows alike (0057): the vector space a result
  // was measured in, so a later model or chunk-shape change can be told apart
  // from a same-space re-score.
  const key = baselineKey();

  // A single row needs no transaction — one INSERT is already atomic, and wrapping
  // it costs a BEGIN and a COMMIT round trip. Measured 2026-08-03: 193.9ms wrapped
  // vs 65.3ms bare. It matters because autotune scores ONE question at a time, so
  // the single-row case is the hot one, not the batch.
  if (rows.length === 1) {
    const r = rows[0];
    await sql`
      insert into eval_results
        (eval_question_id, eval_label_id, k, hit, found_rank, retrieved_ids,
         retrieved_scores, retrieval_state, screen_cutoffs, is_baseline,
         baseline_key)
      values
        (${r.questionId}, ${r.labelId}, ${r.k}, ${r.hit}, ${r.foundRank},
         ${r.retrievedIds}::uuid[], ${r.retrievedScores}::real[],
         ${r.retrievalState},
         ${r.screenCutoffs === null ? null : toJsonb(r.screenCutoffs)},
         ${r.isBaseline ?? false}, ${key})
    `;
    return;
  }

  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        insert into eval_results
          (eval_question_id, eval_label_id, k, hit, found_rank, retrieved_ids,
           retrieved_scores, retrieval_state, screen_cutoffs, is_baseline,
           baseline_key)
        values
          (${r.questionId}, ${r.labelId}, ${r.k}, ${r.hit}, ${r.foundRank},
           ${r.retrievedIds}::uuid[], ${r.retrievedScores}::real[],
           ${r.retrievalState},
           ${r.screenCutoffs === null ? null : toJsonb(r.screenCutoffs)},
           ${r.isBaseline ?? false}, ${key})
      `;
    }
  });
}

// One question's latest stored result, reduced to what the post-autotune dirty
// screen needs (eval.rescoreAffectedQuestions): which state it was scored
// under, what it retrieved, and the 0028 cutoffs. `scoredAt`/`updatedAt` let
// the screen treat edit-stale questions (text changed since scoring) as dirty.
export type ScreeningResult = {
  labelId: string;
  questionId: string;
  updatedAt: Date;
  retrievalState: string | null;
  retrievedIds: string[];
  screenCutoffs: ScreenCutoffs | null;
  scoredAt: Date | null;
};

// Latest result per label under the active config, preferring a row scored
// under `preferState` (the run's FINAL fingerprint) so an already-fresh
// question is recognized as such — same preference rule as getSummary.
// Labels with no result at all come back with null fields (→ dirty).
export async function latestResultsForScreening(
  preferState: string,
): Promise<Map<string, ScreeningResult>> {
  const rows = await sql<
    {
      label_id: string;
      question_id: string;
      updated_at: Date;
      retrieval_state: string | null;
      retrieved_ids: string[] | null;
      screen_cutoffs: ScreenCutoffs | null;
      scored_at: Date | null;
    }[]
  >`
    with labels as (
      select l.id as label_id, q.id as question_id, q.updated_at
      from eval_questions q
      join eval_labels l on l.eval_question_id = q.id
      join document_embeddings de on de.id = l.document_embedding_id
      where de.config_id = ${activeConfig().id}
    ),
    latest as (
      select distinct on (r.eval_label_id)
        r.eval_label_id, r.retrieval_state, r.retrieved_ids, r.screen_cutoffs,
        r.scored_at
      from eval_results r
      join labels lb on lb.label_id = r.eval_label_id
      where not r.is_baseline
      order by r.eval_label_id,
        (r.retrieval_state is not distinct from ${preferState}) desc,
        r.scored_at desc
    )
    select
      lb.label_id, lb.question_id, lb.updated_at,
      lt.retrieval_state, lt.retrieved_ids, lt.screen_cutoffs, lt.scored_at
    from labels lb
    left join latest lt on lt.eval_label_id = lb.label_id
  `;
  return new Map(
    rows.map((r) => [
      r.label_id,
      {
        labelId: r.label_id,
        questionId: r.question_id,
        updatedAt: r.updated_at,
        retrievalState: r.retrieval_state,
        retrievedIds: r.retrieved_ids ?? [],
        screenCutoffs: r.screen_cutoffs,
        scoredAt: r.scored_at,
      },
    ]),
  );
}

// Which of these labels already hold a usable baseline measurement (0057), so the
// scoring pass only pays for the ones that don't.
//
// TWO SOURCES, one query. A row counts when it is either a shadow row from the
// baseline pass (is_baseline) or a live row scored while the config genuinely had
// no overrides — the second is why an untuned config has a baseline for free.
// Both must carry the CURRENT baseline_key: an older key measured a different
// vector space.
export async function labelsWithBaseline(labelIds: string[]): Promise<Set<string>> {
  if (labelIds.length === 0) return new Set();
  const rows = await sql<{ eval_label_id: string }[]>`
    select distinct eval_label_id
    from eval_results
    where eval_label_id = any(${labelIds}::uuid[])
      and baseline_key = ${baselineKey()}
      and (is_baseline or retrieval_state = 'baseline')
  `;
  return new Set(rows.map((r) => r.eval_label_id));
}

// Re-stamp each label's newest `fromState` result as scored-under `toState` —
// for results the dirty screen PROVED identical under the new override state
// (eval.rescoreAffectedQuestions). Only the fingerprint changes; the scores
// were shown to be what a real re-retrieval would produce.
export async function restampLatestResults(
  labelIds: string[],
  fromState: string,
  toState: string,
): Promise<void> {
  if (labelIds.length === 0) return;
  await sql`
    update eval_results
    set retrieval_state = ${toState}
    where id in (
      select distinct on (eval_label_id) id
      from eval_results
      where eval_label_id = any(${labelIds}::uuid[])
        and not is_baseline
        and retrieval_state = ${fromState}
      order by eval_label_id, scored_at desc
    )
  `;
}

// Freeze the current aggregate as a comparison point. config_id scopes the
// snapshot to the active config; the settings columns stay as a denormalized
// record of what produced it.
export async function createRunSnapshot(args: {
  questionCount: number;
  hitCount: number;
  mrr: number | null;
  ndcg: number | null;
  // The nDCG mean's own denominator (0076). `questionCount` is every scored
  // question; only the graded ones are in `ndcg`, and on a partly-graded corpus
  // those are different numbers.
  ndcgCovered?: number | null;
  k?: number; // recall depth this run was scored at (A1); defaults to top_k
}): Promise<void> {
  const cfg = activeConfig();
  await sql`
    insert into eval_runs
      (config_id, model, chunk_size, chunk_overlap, k, question_count, hit_count, mrr, ndcg,
       ndcg_covered)
    values
      (${cfg.id}, ${cfg.embeddingModel}, ${cfg.chunkSize}, ${cfg.chunkOverlap},
       ${args.k ?? cfg.topK}, ${args.questionCount}, ${args.hitCount}, ${args.mrr},
       ${args.ndcg}, ${args.ndcgCovered ?? null})
  `;
}

// eval_questions has no config_id — a question belongs to a DOCUMENT (0002), so
// its owner is documents.user_id. Both mutations below take an id straight from
// the URL, which is why they join through to that column: without it, a guessed
// uuid rewrites or deletes another account's golden-set question.
//
// Returning the matched count rather than void lets the routes 404 on a
// scoped-out id instead of reporting a success that changed nothing.
export async function updateQuestion(id: string, text: string): Promise<boolean> {
  // The text changed, so every cached query vector for it (any model) is stale.
  // Drop them in the same transaction; they repopulate on the next score.
  return sql.begin(async (tx) => {
    const rows = await tx`
      update eval_questions q
      set question = ${text}, source = 'manual', updated_at = now()
      from documents d
      where d.id = q.document_id
        and d.user_id = ${activeUserId()}
        and q.id = ${id}
      returning q.id
    `;
    if (rows.length === 0) return false;
    await tx`delete from eval_question_embeddings where eval_question_id = ${id}`;
    return true;
  });
}

// What an uncache needs to find the banked twin of a question being deleted:
// the wording, and the text of the passage it was written for (the cache is
// keyed on sha256 of that text). Read BEFORE the delete — the label row that
// points at the chunk goes with the question.
export type DeletedQuestion = {
  question: string;
  chunkText: string | null; // null when the chunk table is gone or the label is orphaned
};

export async function deleteQuestion(
  id: string,
): Promise<DeletedQuestion | null> {
  const table = await activeChunksTable();
  const [pre] = table
    ? await sql<{ question: string; chunk_text: string | null }[]>`
        select q.question, c.text as chunk_text
        from eval_questions q
        join documents d on d.id = q.document_id
        left join eval_labels l on l.eval_question_id = q.id
        left join ${sql(table)} c on c.id = l.source_chunk_id
        where d.user_id = ${activeUserId()}
          and q.id = ${id}
        limit 1
      `
    : await sql<{ question: string; chunk_text: string | null }[]>`
        select q.question, null::text as chunk_text
        from eval_questions q
        join documents d on d.id = q.document_id
        where d.user_id = ${activeUserId()}
          and q.id = ${id}
        limit 1
      `;

  const rows = await sql`
    delete from eval_questions q
    using documents d
    where d.id = q.document_id
      and d.user_id = ${activeUserId()}
      and q.id = ${id}
    returning q.id
  `;
  if (rows.length === 0) return null;
  return { question: pre?.question ?? "", chunkText: pre?.chunk_text ?? null };
}

// Assemble the active config's per-chunk override info for the /eval badges: one
// row per overridden chunk, its hover outcomes from the most recent autotune run
// that applied an override there, and the red-❗ gap flag. Only pieces carrying
// token spans can leave a gap (whole-chunk and uniform re-splits store NULL spans
// = full coverage); for those we check the spans cover [0, tokenCount) without
// holes. Both tables are tolerated missing so /eval keeps working pre-migration.
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
        eval_question_id: string;
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
        o.source_chunk_id, o.eval_question_id, q.question, q.difficulty, o.metric,
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
        questionId: r.eval_question_id,
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

// When each question's OFFICIAL (is_truth) ideal ranking was built, under the
// active config — used to tell whether documents arrived after it (making the
// ideal incomplete). Separate from getTruthOrder so that hot path stays lean.
async function truthRankingBuiltAt(
  questionIds: string[],
): Promise<Map<string, number>> {
  if (questionIds.length === 0) return new Map();
  const rows = await sql<{ eval_question_id: string; created_at: Date }[]>`
    select r.eval_question_id, r.created_at
    from eval_rankings r
    join document_embeddings de on de.id = r.document_embedding_id
    where r.is_truth
      and r.eval_question_id = any(${questionIds}::uuid[])
      and de.config_id = ${activeConfig().id}
  `;
  return new Map(rows.map((r) => [r.eval_question_id, r.created_at.getTime()]));
}

// When each document entered the ACTIVE config's corpus — the embedding run's
// time, not the (possibly much older) documents row, since a doc only competes
// in this config's retrieval once it's embedded here. One entry per document.
async function activeDocIngestTimes(): Promise<number[]> {
  const rows = await sql<{ created_at: Date }[]>`
    select min(de.created_at) as created_at
    from document_embeddings de
    where de.config_id = ${activeConfig().id}
    group by de.document_id
  `;
  return rows.map((r) => r.created_at.getTime());
}

// One row of the per-question detail query, shared by getSummary (whole config)
// and getChunkQuestions (one chunk) so the two can't drift apart.
type EvalDetailRow = {
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
  held_out: boolean;
  frozen: boolean;
};

// --- the frozen half of the detail read, and the memo in front of it ---------
//
// THE DEMO'S BIGGEST PER-NAVIGATION READ, measured against a live guest on
// 2026-08-26: getSummary returns 372 KB, and 339 KB of it is the ~460 FROZEN
// question rows (lib/demo/frozen) — the ones a visitor is deliberately not
// allowed to move. The twelve tunable ones are 9 KB. Every switch to the Eval tab
// paid for all of it again.
//
// So the detail query is now read in two halves against the same CTEs, and the
// frozen half goes through a digest-keyed memo (lib/rag/digestMemo): Postgres is
// asked for an md5 over exactly the rows it would have sent, and the rows
// themselves are fetched only when that 48-byte answer is one this process has
// not already seen. On a hit the Eval tab's frozen half costs 48 bytes instead of
// 339 KB, and it is also FASTER — the digest and the tunable half run in the same
// Promise.all the rest of the summary already uses (~160 ms), where the single
// combined query was ~450 ms.
//
// WHY A DIGEST RATHER THAN A PLAIN MEMO, which is what publishedSweep gets away
// with. "Frozen" bounds SPEND, not writes: `notFrozen()` keeps re-scoring off
// these rows and /ignore refuses to unfreeze one, but PATCH and DELETE on
// /api/eval/questions/[id] are not demo-gated, and an autotune apply moves
// `currentState`, which changes which result row `latest` picks for every
// question at once. A memo hooked to a hand-written list of writers would be one
// un-hooked route away from showing a visitor their own edit not taking effect.
// The digest cannot be wrong about that: if any byte of the answer changes, the
// key changes.
//
// NOT A GUEST BRANCH, for the reason lib/demo/frozen's header gives: a real
// account has no frozen rows, so its "frozen" half is empty, its "not frozen"
// half is byte-for-byte the query that ran before, and the only thing this costs
// it is one aggregate over nothing, riding a Promise.all it was already waiting
// on.
const frozenDetailMemo = new DigestMemo<FrozenDetailRow[]>();

// getSummary orders by `d.file_name, c.position, q.created_at` and the dashboard
// groups by chunk on the strength of it, so splitting the read means the halves
// have to be merged back into that order in JS. `created_at` rides along as the
// tiebreak; it is ~30 bytes a row on a MISS and free on a hit, which is the right
// side of the trade for not having to guess at ties within a chunk.
type FrozenDetailRow = EvalDetailRow & { created_at: Date };

// The projection, written once, because the digest and the row fetch describing
// different column sets is the one way a content-addressed key could lie. A
// frozen constant, so sql.unsafe carries no input here.
const DETAIL_COLUMNS =
  "question_id, question, source, difficulty, document_id, updated_at, file_name, " +
  "source_chunk_id, expected_position, hit, found_rank, retrieved_ids, " +
  "retrieved_scores, scored_at, retrieval_state, ignored, held_out, frozen";

// The shared body of both halves and both forms. `frozen` selects the half:
// comparing the marker test to a boolean rather than emitting two different
// predicates keeps the two reads provably complementary — every row that has a
// label under this config lands in exactly one of them.
function detailSource(table: string, currentState: string, frozen: boolean) {
  return sql`
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
      where not r.is_baseline
      order by r.eval_question_id,
        (r.retrieval_state is not distinct from ${currentState}) desc,
        r.scored_at desc
    ),
    detail_rows as (
      select
        q.id as question_id,
        q.question,
        q.source,
        q.difficulty,
        q.document_id,
        q.updated_at,
        q.created_at,
        d.file_name,
        al.source_chunk_id,
        c.position as expected_position,
        lt.hit,
        lt.found_rank,
        lt.retrieved_ids,
        lt.retrieved_scores,
        lt.scored_at,
        lt.retrieval_state,
        (ig.eval_question_id is not null) as ignored,
        (ig.reason is not distinct from 'holdout') as held_out,
        (ig.reason is not distinct from ${FROZEN_REASON}) as frozen
      from eval_questions q
      join active_labels al on al.eval_question_id = q.id
      join documents d on d.id = q.document_id
      left join ${sql(table)} c on c.id = al.source_chunk_id
      left join latest lt on lt.eval_question_id = q.id
      left join config_question_ignores ig
        on ig.eval_question_id = q.id and ig.config_id = ${activeConfig().id}
      where (ig.reason is not distinct from ${FROZEN_REASON}) = ${frozen}
    )
  `;
}

// The 48-byte form. Ordered by question_id INSIDE the aggregate rather than
// inheriting a scan order, because an md5 over a set whose order Postgres is free
// to change would miss for reasons that are not changes.
//
// `created_at` is deliberately outside the digested projection: it is an ordering
// key this function reproduces from other columns' company, not a value any
// caller reads, and digesting it would only add ways to miss.
async function detailDigest(
  table: string,
  currentState: string,
  frozen: boolean,
): Promise<string | null> {
  const [row] = await sql<{ digest: string | null }[]>`
    ${detailSource(table, currentState, frozen)}
    select md5(string_agg(t::text, '|' order by t.question_id)) as digest
      from (select ${sql.unsafe(DETAIL_COLUMNS)} from detail_rows) t
  `;
  return row?.digest ?? null;
}

// The rows themselves, in the order the dashboard expects. The ORDER BY lives on
// the outer select rather than inside the CTE because a CTE's order is not
// something Postgres promises to carry through.
async function detailRows(
  table: string,
  currentState: string,
  frozen: boolean,
): Promise<FrozenDetailRow[]> {
  return sql<FrozenDetailRow[]>`
    ${detailSource(table, currentState, frozen)}
    select ${sql.unsafe(DETAIL_COLUMNS)}, created_at from detail_rows
    -- Document order so questions group cleanly by chunk on /eval; within a
    -- chunk, oldest first (generated, then any manual additions).
    --
    -- question_id is a TIEBREAK THIS QUERY ADDED. A bulk generation writes every
    -- question for a chunk in one statement, so created_at ties to the
    -- millisecond and the old single query left those rows in whatever order the
    -- plan produced — which is also the order the two halves would have to be
    -- merged back into, and there is none to reproduce. Ordering the tie by id
    -- makes the dashboard's within-chunk sequence stable across reloads instead
    -- of merely usually stable, and costs nothing: it only decides rows the
    -- previous ORDER BY declined to.
    order by file_name, expected_position, created_at, question_id
  `;
}

// Re-interleave the two halves into the single ordering the one query used to
// produce. Mirrors `order by d.file_name, c.position, q.created_at` including
// Postgres's default NULLS LAST — `expected_position` is null when a label points
// at a chunk that is gone, and sorting those to the front here would silently
// reorder the dashboard for anyone whose corpus has one.
function byDocumentOrder(a: FrozenDetailRow, b: FrozenDetailRow): number {
  if (a.file_name !== b.file_name) return a.file_name < b.file_name ? -1 : 1;
  if (a.expected_position !== b.expected_position) {
    if (a.expected_position === null) return 1;
    if (b.expected_position === null) return -1;
    return a.expected_position - b.expected_position;
  }
  if (a.created_at.getTime() !== b.created_at.getTime()) {
    return a.created_at.getTime() - b.created_at.getTime();
  }
  // The tiebreak detailRows added — see its ORDER BY. Both are uuids, so a
  // code-point comparison here matches Postgres's uuid ordering; the collation
  // caveat that applies to file_name does not arise.
  return a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0;
}

type DetailContext = {
  currentState: string;
  retrievalChangedAt: Date | null;
  recallK: number;
  mrrK: number;
  ndcgK: number;
  truthOrders: Map<string, string[]>;
};

// Rows → QuestionDetail. Extracted so the chunk-scoped read produces byte-identical
// values to the whole-config one: autotune's keep/revert decision compares a
// `before` from one against an `after` from the other, and any divergence here
// would silently change which overrides survive.
function mapQuestionDetails(
  rows: EvalDetailRow[],
  ctx: DetailContext,
): { questions: QuestionDetail[]; retrievalStale: number; editStaleIds: Set<string> } {
  let retrievalStale = 0;
  const editStaleIds = new Set<string>();
  const questions: QuestionDetail[] = rows.map((r) => {
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
        ? r.retrieval_state !== ctx.currentState
        : ctx.retrievalChangedAt !== null &&
          r.scored_at.getTime() < ctx.retrievalChangedAt.getTime());
    // Frozen rows are excluded: a guest's first autotune moves the config's
    // override fingerprint, which makes all ~460 of them retrieval-stale at once
    // — a "460 questions need re-scoring" badge over work the demo will never do,
    // for rows that are out of the rates anyway. The twelve still count.
    if (retrStale && !editStale && !r.frozen) retrievalStale += 1;
    const stale = editStale || retrStale;
    const scored = r.scored_at !== null;
    // Recompute the hit at the CURRENT recall_k from the stored found_rank (the
    // rank within the stored superset, A1) — so changing recall_k in Settings is
    // reflected without a re-score, as long as it's within the retrieved depth.
    const hit = scored ? r.found_rank !== null && r.found_rank <= ctx.recallK : null;
    // Same recompute-at-current-k treatment for MRR: 1/rank within mrr_k, 0 past it.
    const rr = scored ? reciprocalRank(r.found_rank, ctx.mrrK) : null;
    const countable = scored && !editStale;
    // Graded nDCG needs an ideal ranking AND a countable retrieval order;
    // otherwise it's ungraded (null) and the UI shows the grey placeholder.
    const ideal = ctx.truthOrders.get(r.question_id);
    const qNdcg = countable && ideal ? ndcg(ideal, r.retrieved_ids ?? [], ctx.ndcgK) : null;
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
      rr,
      ndcg: qNdcg,
      ignored: r.ignored,
      heldOut: r.held_out,
      frozen: r.frozen,
    };
  });
  return { questions, retrievalStale, editStaleIds };
}

// The baseline half of the dashboard's detail set (0057): each question's most
// recent OVERRIDE-FREE measurement, in the exact row shape the live detail query
// produces, so mapQuestionDetails + reduceMetrics are reused verbatim.
//
// Two sources, one `latest`: rows from the baseline pass, and live rows scored
// while the config had no overrides. is_baseline rows win at equal recency —
// they were measured deliberately against today's corpus.
async function baselineDetailRows(table: string): Promise<EvalDetailRow[]> {
  return sql<EvalDetailRow[]>`
    with active_labels as (
      select l.id as label_id, l.eval_question_id, l.source_chunk_id
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      where de.config_id = ${activeConfig().id}
    ),
    latest as (
      select distinct on (r.eval_question_id)
        r.eval_question_id, r.hit, r.found_rank, r.retrieved_ids,
        r.retrieved_scores, r.scored_at, r.retrieval_state
      from eval_results r
      join active_labels al on al.label_id = r.eval_label_id
      where r.baseline_key = ${baselineKey()}
        and (r.is_baseline or r.retrieval_state = 'baseline')
      order by r.eval_question_id, r.scored_at desc, r.is_baseline desc
    )
    select
      q.id as question_id, q.question, q.source, q.difficulty, q.document_id,
      q.updated_at, d.file_name, al.source_chunk_id,
      c.position as expected_position,
      lt.hit, lt.found_rank, lt.retrieved_ids, lt.retrieved_scores,
      lt.scored_at, lt.retrieval_state,
      (ig.eval_question_id is not null) as ignored,
      (ig.reason is not distinct from 'holdout') as held_out,
      (ig.reason is not distinct from ${FROZEN_REASON}) as frozen
    from eval_questions q
    join active_labels al on al.eval_question_id = q.id
    join documents d on d.id = q.document_id
    left join ${sql(table)} c on c.id = al.source_chunk_id
    join latest lt on lt.eval_question_id = q.id
    left join config_question_ignores ig
      on ig.eval_question_id = q.id and ig.config_id = ${activeConfig().id}
  `;
}

// QuestionDetail[] → the headline rates. One function so the live summary and
// the baseline aggregate CANNOT drift: the ticker is a subtraction between the
// two, and a rate computed two slightly different ways would show a delta that
// is an artefact of the arithmetic rather than of any tuning.
//
// The arithmetic itself is lib/rag/evalRates.ts, which imports nothing, so the
// client can compute the live train/holdout split off the rows it already has
// without a second copy of these rules. This wrapper survives because getSummary
// destructures its result and because `rated` — the headline partition — is a
// choice worth naming at the one call site that is not making a split.
//
// editStaleIds is gone from the signature: it was always exactly the set of rows
// whose own `editStale` flag is true (mapQuestionDetails builds both in the same
// pass), and a set threaded alongside the rows it describes is one more thing two
// call sites can get out of step.
function reduceMetrics(questions: QuestionDetail[]) {
  return reduceRates(questions, "rated");
}

// ONE CHUNK's questions, in the exact shape getSummary would give them.
//
// Autotune's confirm step called the whole-config getSummary() two or three times
// per confirm and then filtered to a single chunk — ~1.1s each against a
// 162-question corpus, ~150 per run, so ~167s of an 894s run to read 1–2
// questions at a time.
//
// The savings are twofold: the `latest` CTE runs over one chunk's results instead
// of the whole corpus, and the five aggregate queries plus the corpus-wide nDCG
// drift analysis are skipped entirely.
//
// Shares mapQuestionDetails with getSummary, so `stale`, `hit`, `rr` and `ndcg`
// are computed identically — the keep/revert comparison puts a `before` from this
// function against an `after` from it.
export async function getChunkQuestions(
  chunkId: string,
): Promise<{ questions: QuestionDetail[]; criteria: EvalCriteria }> {
  const cfg = activeConfig();

  // These four reads have no data dependency on each other, and run sequentially
  // cost four round trips — measured 2026-08-03 at ~129ms EACH, i.e. 40% of the
  // function spent waiting. One Promise.all makes it one round trip.
  //
  // Deliberately NOT hoisted to run scope: `criteria` and the table are constant
  // for a run, but the fingerprint is not — it changes as overrides land mid-run,
  // and a stale one silently mis-labels fresh results.
  const [criteria, table, currentState, retrievalChangedAt] = await Promise.all([
    getActiveCriteria(),
    activeChunksTable(),
    retrievalStateFingerprint(),
    getRetrievalChangedAt(),
  ]);
  const recallK = effectiveK(criteria.recall, cfg.topK);
  const mrrK = effectiveK(criteria.mrr, cfg.topK);
  const ndcgK = effectiveK(criteria.ndcg, cfg.topK);

  if (!table) return { questions: [], criteria };

  // Same query as getSummary's detail select, with the chunk filter pushed into
  // active_labels so `latest` only scans this chunk's results.
  const detail = await sql<EvalDetailRow[]>`
    with active_labels as (
      select l.id as label_id, l.eval_question_id, l.source_chunk_id
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      where de.config_id = ${cfg.id} and l.source_chunk_id = ${chunkId}
    ),
    latest as (
      select distinct on (r.eval_question_id)
        r.eval_question_id, r.hit, r.found_rank, r.retrieved_ids,
        r.retrieved_scores, r.scored_at, r.retrieval_state
      from eval_results r
      join active_labels al on al.label_id = r.eval_label_id
      where not r.is_baseline
      order by r.eval_question_id,
        (r.retrieval_state is not distinct from ${currentState}) desc,
        r.scored_at desc
    )
    select
      q.id as question_id, q.question, q.source, q.difficulty, q.document_id,
      q.updated_at, d.file_name, al.source_chunk_id,
      c.position as expected_position,
      lt.hit, lt.found_rank, lt.retrieved_ids, lt.retrieved_scores,
      lt.scored_at, lt.retrieval_state,
      (ig.eval_question_id is not null) as ignored,
      (ig.reason is not distinct from 'holdout') as held_out,
      (ig.reason is not distinct from ${FROZEN_REASON}) as frozen
    from eval_questions q
    join active_labels al on al.eval_question_id = q.id
    join documents d on d.id = q.document_id
    left join ${sql(table)} c on c.id = al.source_chunk_id
    left join latest lt on lt.eval_question_id = q.id
    left join config_question_ignores ig
      on ig.eval_question_id = q.id and ig.config_id = ${cfg.id}
    order by d.file_name, c.position, q.created_at
  `;

  const truthOrders = await getTruthOrder(detail.map((r) => r.question_id));
  const { questions } = mapQuestionDetails(detail, {
    currentState,
    retrievalChangedAt,
    recallK,
    mrrK,
    ndcgK,
    truthOrders,
  });
  return { questions, criteria };
}

export async function getSummary(): Promise<EvalSummary> {
  const cfg = activeConfig();
  const criteria = await getActiveCriteria();
  // Asked once per lap, before the early return: an empty config's page has the
  // same blocked buttons on it as a full one.
  //
  // TWO OF THE SEVEN COME OFF WHEN THE SHELF IS STOCKED (phase 5 of
  // docs/demo-real-flow-plan.md). "Add nDCG rankings" and "Add LLM nDCG rankings"
  // are steps 4 and 5 of the demo's walk, and a build published with the master's
  // banked rankings (0082) lets both run for free — so rendering them disabled
  // would grey out the two buttons the visitor is there to press. The routes make
  // the same call in the same order, so the tooltip and the 403 cannot disagree:
  // a build published WITHOUT the shelf greys them and refuses, as before.
  const [bankedIdeals, bankedLlm] = await Promise.all([readIdeals(), readLlmRankings()]);
  const demoBlocked = await demoBlockedSentences(
    EVAL_DEMO_ACTIONS.filter(
      (a) => !(a === "rank" && bankedIdeals) && !(a === "llmRank" && bankedLlm),
    ),
  );
  const recallK = effectiveK(criteria.recall, cfg.topK);
  const mrrK = effectiveK(criteria.mrr, cfg.topK);
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
    mrrK,
    ndcgK,
    total: 0,
    scored: 0,
    hits: 0,
    recall: null,
    mrr: null,
    ndcg: null,
    ndcgCovered: 0,
    ndcgStaleDocs: 0,
    ndcgStaleRescore: false,
    ndcgStaleRebuild: false,
    ndcgStuckTruths: [],
    baseline: null,
    perDocument: [],
    questions: [],
    runs: [],
    asPublished: null,
    holdoutRuns: 0,
    pendingChunks: 0,
    pendingScoring: 0,
    retrievalStale: 0,
    retrievalChanges: [],
    chunkCount: 0,
    chunks: [],
    demoBlocked,
    demoBoard: null,
    criteria,
    config: configInfo,
    overrides: [],
  };

  const table = await activeChunksTable();
  if (!table) return empty;

  // Fetched first: the detail query below prefers results scored under the
  // CURRENT override state, so it needs the fingerprint as a parameter — and the
  // chunk query below needs the demo's board scope, for the same reason. Both
  // ride one Promise.all so the pair costs one round trip rather than two, and
  // readBoard is memoed per process besides.
  const [currentState, board] = await Promise.all([
    retrievalStateFingerprint(),
    readBoard(),
  ]);
  // Null for every account but a demo guest, so the chunk query below is
  // byte-for-byte the query it has always been for everyone else — the rule
  // lib/demo/frozen's header states and the reason this is a bound parameter
  // rather than a branch.
  const boardIds = board?.chunks ?? null;

  // THE FROZEN HALF IS ASKED FOR BY DIGEST FIRST — see frozenDetailMemo above.
  // Both of these ride the same Promise.all the rest of the summary already
  // waits on, so the split costs no extra wall-clock round trip; only the
  // frozen-half FETCH below is sequential, and only on a miss.
  const frozenKey = cacheKey(activeUserId(), activeConfig().id);
  const [
    tunableDetail,
    frozenDigest,
    runRows,
    pendingChunkRows,
    chunkRows,
    overrides,
    retrievalChangedAt,
    changeLog,
    holdoutRunRows,
  ] = await Promise.all([
    detailRows(table, currentState, false),
    detailDigest(table, currentState, true),
    sql<
      {
        id: string;
        k: number;
        question_count: number;
        hit_count: number;
        mrr: number | null;
        ndcg: number | null;
        ndcg_covered: number | null;
        notes: string | null;
        created_at: Date;
      }[]
    >`
      select id, k, question_count, hit_count, mrr, ndcg, ndcg_covered, notes, created_at
      from eval_runs
      where config_id = ${activeConfig().id}
      order by created_at desc
      limit 20
    `,
    // Count of chunks under the active config missing a question for at least
    // one difficulty this config has used — scope reporting for Bulk actions →
    // Add, not a gate on anything.
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
    // Every chunk, not a count of them: the dashboard needs one card per chunk
    // whether or not it has questions, and `chunkCount` falls out of the length.
    // Ordered to match the question detail query above (document, then position)
    // so seeded groups and question-bearing groups interleave in one sequence.
    sql<{ id: string; file_name: string; position: number | null }[]>`
      select c.id, doc.file_name, c.position
      from ${sql(table)} c
      join document_embeddings de on de.id = c.document_embedding_id
      join documents doc on doc.id = c.document_id
      where de.config_id = ${activeConfig().id}
        -- THE DEMO'S BOARD, applied here and nowhere else (0081). A guest's
        -- workspace holds the whole 236-chunk corpus — retrieval is measured
        -- against all of it, which is what makes their scores real — while the
        -- Eval tab is a walk over the ~30 the publish chose. Filtering in SQL
        -- rather than in the client is what turns 236 chunk refs on every lap
        -- into 30. Null (every real account) leaves the predicate true.
        and (${boardIds}::uuid[] is null or c.id = any(${boardIds}::uuid[]))
      order by doc.file_name, c.position
    `,
    listChunkOverrideInfo(table),
    getRetrievalChangedAt(),
    listRetrievalChanges(),
    // One indexed count over a table with a handful of rows per config. It rides
    // this Promise.all rather than becoming a request of its own because it is
    // the GATE for the holdout section: a fetch to decide whether to render a
    // collapsed section is a fetch on every page load for every config.
    sql<{ n: number }[]>`
      select count(*)::int as n from autotune_runs
      where config_id = ${activeConfig().id} and holdout_n is not null
    `,
  ]);

  // THE MEMO'S ONE DECISION. A hit costs the 48 bytes of digest already paid for
  // above; a miss pays the frozen fetch here, sequentially, because there was
  // nothing to fetch until the digest said so. Empty for any account with no
  // frozen rows, which is every account but a demo guest — so `frozen` is [] and
  // `detail` below is exactly the row set the single query used to return.
  let frozenDetail = frozenDetailMemo.get(frozenKey, frozenDigest);
  if (frozenDetail === undefined) {
    frozenDetail = await detailRows(table, currentState, true);
    // Stored under the digest we ASKED with, not one re-derived from the rows: a
    // write landing between the two reads must leave this entry unreachable
    // rather than blessed, and the next request's digest is what notices.
    frozenDetailMemo.set(frozenKey, frozenDigest, frozenDetail);
  }
  // Back into the one ordering the dashboard groups on — see byDocumentOrder.
  // sort() is stable in V8, but the comparator is total over the three keys the
  // SQL ordered by, so stability is not being leaned on.
  const detail: EvalDetailRow[] =
    frozenDetail.length === 0
      ? tunableDetail
      : [...tunableDetail, ...frozenDetail].sort(byDocumentOrder);

  // Each question's official (is_truth) ideal ranking, if any — what its graded
  // nDCG scores against. One query for all questions.
  const truthOrders = await getTruthOrder(detail.map((r) => r.question_id));

  // Results scored before the last retrieval-shape change (override/delegate set
  // or cleared) were produced by a retrieval that no longer exists. They still
  // COUNT toward the rates (badged stale, refreshed next run) — only edit-stale
  // rows are excluded, since their score belongs to the question's OLD text.
  const { questions, retrievalStale, editStaleIds } = mapQuestionDetails(detail, {
    currentState,
    retrievalChangedAt,
    recallK,
    mrrK,
    ndcgK,
    truthOrders,
  });

  const { scoredRows, hits, recall, mrr, ndcg: ndcgValue, ndcgCovered } =
    reduceMetrics(questions);

  // What the per-chunk tuning has bought. Only when overrides exist: without
  // them live IS baseline and the delta is zero by construction, so the one
  // extra query is skipped along with the row of dashes it would produce.
  let baseline: EvalBaseline | null = null;
  if (overrides.length > 0) {
    const baseRows = await baselineDetailRows(table);
    // currentState 'baseline' is the fingerprint these rows were genuinely
    // scored under, so none is mislabelled stale; retrievalChangedAt is not
    // consulted for them for the same reason.
    const { questions: baseQuestions } = mapQuestionDetails(
      baseRows,
      {
        currentState: "baseline",
        retrievalChangedAt: null,
        recallK,
        mrrK,
        ndcgK,
        truthOrders,
      },
    );
    // BOTH SIDES OVER THE SAME QUESTIONS — the intersection of what counts
    // live and what counts on the baseline. A delta between differently sized
    // question sets is meaningless, and the UI reports this size.
    const baseCountable = new Set(
      reduceMetrics(baseQuestions).scoredRows.map((q) => q.questionId),
    );
    const liveSubset = scoredRows.filter((q) => baseCountable.has(q.questionId));
    const subsetIds = new Set(liveSubset.map((q) => q.questionId));
    if (subsetIds.size > 0) {
      const base = reduceMetrics(baseQuestions.filter((q) => subsetIds.has(q.questionId)));
      const live = reduceMetrics(liveSubset);
      baseline = {
        questions: subsetIds.size,
        recall: base.recall,
        mrr: base.mrr,
        ndcg: base.ndcg,
        liveRecall: live.recall,
        liveMrr: live.mrr,
        liveNdcg: live.ndcg,
      };
    }
  }

  // nDCG corpus-drift: documents that entered this config after the graded set's
  // ideals were built and/or after it was scored. Each input ages the number
  // independently — a doc after the ideal makes it incomplete (rebuild fixes), a
  // doc after the score makes retrieval stale (re-score fixes). staleDocs is sized
  // off the EARLIEST such input. Skipped entirely when nothing is graded.
  let ndcgStaleDocs = 0;
  let ndcgStaleRescore = false;
  let ndcgStaleRebuild = false;
  const stuckTruths = new Map<string, string>(); // chunk -> kind label (deduped)
  const gradedQuestions = questions.filter((q) => q.ndcg !== null && !q.ignored);
  if (gradedQuestions.length > 0) {
    const gradedIds = gradedQuestions.map((q) => q.questionId);
    const [truthBuiltAt, truthKinds, docTimes] = await Promise.all([
      truthRankingBuiltAt(gradedIds),
      truthKindByQuestion(gradedIds),
      activeDocIngestTimes(),
    ]);
    const newestDoc = docTimes.length > 0 ? Math.max(...docTimes) : null;
    if (newestDoc !== null) {
      let earliestInput = Infinity;
      for (const q of gradedQuestions) {
        const builtAt = truthBuiltAt.get(q.questionId) ?? null;
        if (q.scoredAt !== null && newestDoc > q.scoredAt) ndcgStaleRescore = true;
        if (builtAt !== null && newestDoc > builtAt) {
          // Ideal predates a newer document. An aggregate ideal the bulk rebuild
          // refreshes; a manual/LLM truth it leaves alone, so name that chunk as
          // needing a hand-fix instead of implying a rebuild would clear it.
          if (truthKinds.get(q.questionId) === "aggregate") {
            ndcgStaleRebuild = true;
          } else {
            const chunk = `${q.fileName}#${q.expectedPosition ?? "?"}`;
            stuckTruths.set(
              chunk,
              TRUTH_KIND_LABEL[truthKinds.get(q.questionId) ?? "manual"],
            );
          }
        }
        const threshold = Math.min(builtAt ?? Infinity, q.scoredAt ?? Infinity);
        if (threshold < earliestInput) earliestInput = threshold;
      }
      ndcgStaleDocs = docTimes.filter((t) => t > earliestInput).length;
    }
  }
  const ndcgStuckTruths = [...stuckTruths].map(([chunk, kind]) => ({ chunk, kind }));

  // Questions "Score pending" would score: never scored, or edited since.
  // Matches questionsNeedingScoring() — no extra query needed.
  // Same exclusion as retrievalStale above, and for the same reason: this number
  // enables "Score pending", and pointing that button at frozen questions the
  // scoped query will not return would leave it permanently lit with nothing to do.
  const pendingScoring = questions.filter(
    (q) => (q.hit === null || q.stale) && !q.frozen,
  ).length;

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

  const runs: RunSnapshot[] = runRows.map((r) => ({
    id: r.id,
    k: r.k,
    questionCount: r.question_count,
    hitCount: r.hit_count,
    mrr: r.mrr,
    ndcg: r.ndcg,
    ndcgCovered: r.ndcg_covered,
    createdAt: r.created_at.getTime(),
    notes: r.notes,
  }));

  return {
    k: recallK,
    recallK,
    mrrK,
    ndcgK,
    total: questions.length,
    scored: scoredRows.length,
    hits,
    recall,
    mrr,
    ndcg: ndcgValue,
    ndcgCovered,
    ndcgStaleDocs,
    ndcgStaleRescore,
    ndcgStaleRebuild,
    ndcgStuckTruths,
    baseline,
    perDocument: [...byDoc.values()],
    questions,
    runs,
    // runRows is already ordered newest-first, and a published snapshot holds
    // exactly one row — so for a guest "the newest run" and "the build they were
    // handed" are the same row. For everyone else this stays null and the Eval tab
    // renders exactly as it always has.
    // BY NAME, NOT BY RECENCY. Phase 4 lets a guest write eval_runs rows of their
    // own (a re-score and an autotune each snapshot one), so "the newest run" would
    // relabel a visitor's own result as the published build's frozen headline —
    // the exact lie this card exists to stop telling. The publish writes exactly
    // one row carrying PUBLISHED_RUN_NOTE; that is the row, or there is none.
    asPublished: (await isGuest())
      ? (runs.find((r) => r.notes === PUBLISHED_RUN_NOTE) ?? null)
      : null,
    holdoutRuns: holdoutRunRows[0]?.n ?? 0,
    pendingChunks: pendingChunkRows[0]?.n ?? 0,
    pendingScoring,
    retrievalStale,
    // Log entries can outlive their stale rows (e.g. a scoped re-score covered
    // them all) — hide the history once nothing is actually stale.
    retrievalChanges:
      retrievalStale > 0
        ? changeLog.map((c) => ({ description: c.description, at: c.at.getTime() }))
        : [],
    chunkCount: chunkRows.length,
    chunks: chunkRows.map((r) => ({
      chunkId: r.id,
      fileName: r.file_name,
      position: r.position,
    })),
    demoBlocked,
    demoBoard: boardIds,
    criteria,
    config: configInfo,
    overrides,
  };
}
