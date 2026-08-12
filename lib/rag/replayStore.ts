// OFFLINE REPLAY (migration 0043) — real full-corpus retrieval metrics for every
// candidate embedding model, for $0.
//
// THE IDEA: every vector we need is already banked. embedding_cache (0020) is
// content-addressed by (model, input_kind, sha256(text)), and autotune, the
// per-chunk trials and the key-model sweep have between them embedded the whole
// corpus AND the eval questions under every Voyage model. So we can rank the
// full corpus for each model, score it against the stored gold labels, and never
// call a provider.
//
// WHY IT BEATS eval_model_trials: a trial re-ranks inside a candidate pool that
// contains the correct chunk by construction, so every model scores ~1.000 and
// nothing is comparable. Here every model ranks the SAME full corpus, on the
// SAME questions, by the SAME exact-cosine scan. Only the model changes.
//
// HONEST LIMITS, which the UI must carry:
//   - Exact scan, not HNSW. Live retrieval uses an ANN index; this brute-forces
//     cosine over every chunk. So these are best-case numbers and won't exactly
//     reproduce a stored eval_runs row — but the method is identical across
//     models, which is what makes the COMPARISON fair.
//   - Chunking is held at the config's own. A model that would prefer different
//     chunk sizes is being judged on someone else's chunking.
//   - A model is scored only at 100% corpus coverage (see scoreModel).
import { createHash } from "node:crypto";

import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { EMBEDDING_MODELS } from "@/lib/rag/embeddingModels";
import { ndcg } from "@/lib/rag/evalMetrics";
import { goldRank, leaveOneOutIdeal, rankTexts, summarizeRanks } from "@/lib/rag/replayMetrics";
import { chunksTable, modelDimension } from "@/lib/rag/vectorStore";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export type ReplayRow = {
  model: string;
  questions: number;
  corpusChunks: number;
  coverageChunks: number;
  // Null when coverage < 100% — the model is listed but not scorable.
  recallAt1: number | null;
  recallAt3: number | null;
  recallAt5: number | null;
  recallAt10: number | null;
  mrr: number | null;
  // Graded nDCG@k against the ideal ranking, with the leave-one-out correction
  // applied when this model helped build that ideal (see replayMetrics).
  ndcg: number | null;
  ndcgK: number | null;
  ndcgLeaveOneOut: boolean;
  computedAt: number | null;
};

export type ReplayReport = {
  configId: string;
  configLabel: string;
  corpusChunks: number;
  questions: number;
  rows: ReplayRow[]; // MRR desc; unscorable models last
  fromCache: boolean;
};

// --- inputs -----------------------------------------------------------------

type Corpus = {
  chunks: { text: string }[]; // distinct chunk texts, the retrieval pool
  labels: { question: string; goldText: string }[];
  // Graded ideal per question, in TEXT space (the cache's key) rather than chunk
  // ids, so duplicate-text chunks can't split a ranking. `perModelRanks` is kept
  // so the ideal can be rebuilt without the model under test.
  ideals: Map<string, { idealTexts: string[]; perModelRanks: Record<string, Record<string, number>> }>;
  textById: Map<string, string>; // chunk id -> text, to translate stored ideals
  topK: number; // the config's k — the depth nDCG is reported at
};

// The config's corpus chunks and its labelled questions.
//
// Labels are already config-scoped through document_embeddings.config_id, so no
// corpus join is needed. We match the gold chunk by TEXT rather than id, because
// the cache is keyed on text — and a chunk re-ingested under new settings gets a
// new id but the same text.
async function loadCorpus(
  configId: string,
  baseModel: string,
  topK: number,
): Promise<Corpus> {
  const table = chunksTable(baseModel, modelDimension(baseModel));

  const [chunks, labels, rankings, idMap] = await Promise.all([
    // distinct on text: duplicate chunk texts would otherwise both sit in the
    // pool and split the ranking, and the cache can't tell them apart anyway.
    sql<{ text: string }[]>`
      select distinct text from ${sql(table)} where config_id = ${configId}
    `,
    sql<{ question: string; gold_text: string }[]>`
      select q.question, c.text as gold_text
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      join eval_questions q on q.id = l.eval_question_id
      join ${sql(table)} c on c.id = l.source_chunk_id
      where de.config_id = ${configId}
    `,
    // The graded ideal per question. Only is_truth counts — the other kinds
    // (llm_pool, llm_rerank, manual) are alternatives the user hasn't adopted,
    // and 0009 is explicit that nDCG scores against the marked one.
    sql<{ question: string; chunk_ids: string[]; details: { perModelRanks?: Record<string, Record<string, number>> } }[]>`
      select q.question, r.chunk_ids, r.details
      from eval_rankings r
      join document_embeddings de on de.id = r.document_embedding_id
      join eval_questions q on q.id = r.eval_question_id
      where de.config_id = ${configId} and r.is_truth
    `,
    sql<{ id: string; text: string }[]>`
      select id, text from ${sql(table)} where config_id = ${configId}
    `,
  ]);

  // Ideals arrive as chunk IDS; everything else in the replay works in TEXT
  // space (the cache is keyed on text). Translate once here, dropping ids that
  // no longer resolve — a ranking can outlive a re-chunk.
  const textById = new Map(idMap.map((r) => [r.id, r.text]));
  const ideals = new Map<
    string,
    { idealTexts: string[]; perModelRanks: Record<string, Record<string, number>> }
  >();
  for (const r of rankings) {
    const idealTexts = r.chunk_ids
      .map((id) => textById.get(id))
      .filter((t): t is string => t !== undefined);
    if (idealTexts.length === 0) continue;
    ideals.set(r.question, {
      idealTexts,
      perModelRanks: r.details?.perModelRanks ?? {},
    });
  }

  return {
    chunks,
    labels: labels.map((l) => ({ question: l.question, goldText: l.gold_text })),
    ideals,
    textById,
    topK,
  };
}

// The ideal order (in text space) to grade `model` against for one question.
//
// If the model contributed to the stored aggregate, rebuild it from the OTHER
// contributors — otherwise the model is graded against a target it helped write.
// Non-contributors get the stored ideal unchanged.
function idealFor(
  entry: { idealTexts: string[]; perModelRanks: Record<string, Record<string, number>> },
  model: string,
  textById: Map<string, string>,
): { ideal: string[]; corrected: boolean } {
  const contributed = Object.values(entry.perModelRanks).some((r) => model in r);
  if (!contributed) return { ideal: entry.idealTexts, corrected: false };

  const rebuilt = leaveOneOutIdeal(entry.perModelRanks, model);
  if (!rebuilt) return { ideal: entry.idealTexts, corrected: false };

  const texts = rebuilt
    .map((id) => textById.get(id))
    .filter((t): t is string => t !== undefined);
  // Fall back rather than grade against an empty ideal (evalMetrics.ndcg would
  // return null anyway, but this keeps the reason explicit).
  if (texts.length === 0) return { ideal: entry.idealTexts, corrected: false };
  return { ideal: texts, corrected: true };
}

// A hash of everything the replay's answer depends on. Same fingerprint ⇒ the
// stored rows are still correct, so we can skip the ~3s recompute.
//
// The document-vector COUNT is the coverage proxy: it changes whenever any model
// gains a cached chunk vector, which is the only way an under-covered model can
// become scorable. It over-invalidates (an unrelated ingest bumps it too) — see
// 0043's header for why that trade is deliberate.
//
// Scoped to the user's own rows since 0050. Unqualified, this count was the one
// place that broke embedding_cache's implicit "every lookup brings its own
// text_hash" invariant, and it was a functional bug on top of a tenancy one:
// ANOTHER ACCOUNT'S INGEST bumped the count and threw away this user's replay.
// Deliberate over-invalidation within one tenant is the trade 0043 accepted;
// across tenants it was never anything but noise.
async function fingerprint(configId: string, corpus: Corpus): Promise<string> {
  const [{ count }] = await sql<{ count: string }[]>`
    select count(*) as count from embedding_cache
    where user_id = ${activeUserId()} and input_kind = 'document'
  `;

  const chunkPart = corpus.chunks.map((c) => sha256(c.text)).sort().join(",");
  const labelPart = corpus.labels
    .map((l) => `${sha256(l.question)}:${sha256(l.goldText)}`)
    .sort()
    .join(",");
  // The graded ideal is an input too: re-rank a question, or mark a different
  // ranking as truth, and every model's nDCG changes. Hashing the ORDER (not
  // just membership) is the point — a reordered ideal is a different target.
  const idealPart = [...corpus.ideals.entries()]
    .map(([q, e]) => `${sha256(q)}:${e.idealTexts.map(sha256).join(">")}`)
    .sort()
    .join(",");

  return createHash("md5")
    .update(`${configId}|${count}|${chunkPart}|${labelPart}|${idealPart}|k=${corpus.topK}`)
    .digest("hex");
}

// --- the computation --------------------------------------------------------

// Cached vectors for `texts` under `model`. Cache-only: never calls a provider,
// so a replay can't spend money by accident — and, since 0050, only over vectors
// this account's own provider key paid for. That is what makes the "$0 model
// comparison" honest rather than a subsidy: a model the user has never run under
// stays under-covered and unscorable instead of borrowing someone else's pool.
async function cachedVectors(
  model: string,
  texts: string[],
  kind: "document" | "query",
): Promise<Map<string, number[]>> {
  if (texts.length === 0) return new Map();
  const hashes = texts.map(sha256);
  const rows = await sql<{ text_hash: string; embedding: number[] }[]>`
    select text_hash, embedding
    from embedding_cache
    where user_id = ${activeUserId()}
      and model = ${model} and input_kind = ${kind} and text_hash = any(${hashes})
  `;
  const byHash = new Map(rows.map((r) => [r.text_hash, r.embedding]));
  const out = new Map<string, number[]>();
  texts.forEach((t, i) => {
    const v = byHash.get(hashes[i]);
    if (v) out.set(t, v);
  });
  return out;
}

// Score one model over the full corpus. Returns null metrics unless the model
// covers EVERY chunk: a partial pool has fewer distractors, which inflates every
// metric — the precise bias the replay exists to escape, so we refuse rather
// than caveat it.
async function scoreModel(model: string, corpus: Corpus): Promise<ReplayRow> {
  const texts = corpus.chunks.map((c) => c.text);
  const docs = await cachedVectors(model, texts, "document");
  const unscorable: ReplayRow = {
    model,
    questions: 0,
    corpusChunks: texts.length,
    coverageChunks: docs.size,
    recallAt1: null,
    recallAt3: null,
    recallAt5: null,
    recallAt10: null,
    mrr: null,
    ndcg: null,
    ndcgK: null,
    ndcgLeaveOneOut: false,
    computedAt: Date.now(),
  };
  if (docs.size < texts.length) return unscorable;

  const questions = corpus.labels.map((l) => l.question);
  const queries = await cachedVectors(model, questions, "query");

  // Materialize the pool once — one array of (text, vector) reused by every
  // question, rather than re-reading the Map per comparison.
  const pool = texts.map((t) => ({ text: t, vec: docs.get(t)! }));

  const ranks: number[] = [];
  const ndcgs: number[] = [];
  let anyCorrected = false;
  for (const { question, goldText } of corpus.labels) {
    const qv = queries.get(question);
    if (!qv) continue; // question never embedded under this model — skip, don't guess
    // A gold chunk outside the pool can't be ranked at all. Shouldn't happen
    // (both are config-scoped), but a label surviving a re-chunk would land here
    // — skipping is right, and crashing on an undefined vector is not.
    const goldVec = docs.get(goldText);
    if (!goldVec) continue;
    ranks.push(goldRank(qv, goldVec, pool, goldText));

    // nDCG needs the whole retrieved ORDER, not just where the gold chunk fell,
    // and a graded ideal to score it against. Questions without a truth ranking
    // simply don't contribute — evalMetrics.ndcg's "ungraded" contract.
    const entry = corpus.ideals.get(question);
    if (!entry) continue;
    const { ideal, corrected } = idealFor(entry, model, corpus.textById);
    const score = ndcg(ideal, rankTexts(qv, pool), corpus.topK);
    if (score === null) continue;
    ndcgs.push(score);
    if (corrected) anyCorrected = true;
  }

  const metrics = summarizeRanks(ranks);
  if (metrics.questions === 0) return unscorable;
  return {
    model,
    corpusChunks: texts.length,
    coverageChunks: docs.size,
    ndcg: ndcgs.length > 0 ? ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length : null,
    ndcgK: ndcgs.length > 0 ? corpus.topK : null,
    ndcgLeaveOneOut: anyCorrected,
    computedAt: Date.now(),
    ...metrics,
  };
}

// --- cache read/write -------------------------------------------------------

async function readCached(configId: string, fp: string): Promise<ReplayRow[] | null> {
  try {
    const rows = await sql<
      {
        model: string;
        questions: number;
        corpus_chunks: number;
        coverage_chunks: number;
        recall_at_1: string | null;
        recall_at_3: string | null;
        recall_at_5: string | null;
        recall_at_10: string | null;
        mrr: string | null;
        ndcg: string | null;
        ndcg_k: number | null;
        ndcg_leave_one_out: boolean;
        computed_at: Date;
      }[]
    >`
      select model, questions, corpus_chunks, coverage_chunks,
             recall_at_1, recall_at_3, recall_at_5, recall_at_10, mrr,
             ndcg, ndcg_k, ndcg_leave_one_out, computed_at
      from replay_metrics
      where config_id = ${configId} and fingerprint = ${fp}
    `;
    if (rows.length === 0) return null;
    const num = (v: string | null) => (v === null ? null : Number(v));
    return rows.map((r) => ({
      model: r.model,
      questions: r.questions,
      corpusChunks: r.corpus_chunks,
      coverageChunks: r.coverage_chunks,
      recallAt1: num(r.recall_at_1),
      recallAt3: num(r.recall_at_3),
      recallAt5: num(r.recall_at_5),
      recallAt10: num(r.recall_at_10),
      mrr: num(r.mrr),
      ndcg: num(r.ndcg),
      ndcgK: r.ndcg_k,
      ndcgLeaveOneOut: r.ndcg_leave_one_out,
      computedAt: r.computed_at.getTime(),
    }));
  } catch (err) {
    if (isMissingTable(err)) return null; // pre-migration: recompute every time
    throw err;
  }
}

// Store this fingerprint's rows. Old fingerprints for the config are deleted —
// this is a cache, not a history, and stale generations would only ever grow.
async function writeCached(configId: string, fp: string, rows: ReplayRow[]): Promise<void> {
  try {
    await sql`delete from replay_metrics where config_id = ${configId} and fingerprint <> ${fp}`;
    for (const r of rows) {
      await sql`
        insert into replay_metrics (
          fingerprint, config_id, model, questions, corpus_chunks, coverage_chunks,
          recall_at_1, recall_at_3, recall_at_5, recall_at_10, mrr,
          ndcg, ndcg_k, ndcg_leave_one_out
        ) values (
          ${fp}, ${configId}, ${r.model}, ${r.questions}, ${r.corpusChunks},
          ${r.coverageChunks}, ${r.recallAt1}, ${r.recallAt3}, ${r.recallAt5},
          ${r.recallAt10}, ${r.mrr}, ${r.ndcg}, ${r.ndcgK}, ${r.ndcgLeaveOneOut}
        )
        on conflict (fingerprint, config_id, model) do nothing
      `;
    }
  } catch (err) {
    if (isMissingTable(err)) return; // pre-migration: nothing to store into
    throw err;
  }
}

// --- entry point ------------------------------------------------------------

// Every config that has labelled eval questions — the ones a replay can score.
// Ordered like the config tabs so the page's sections match the rest of the app.
async function replayableConfigs(): Promise<
  { id: string; label: string; baseModel: string; topK: number }[]
> {
  const rows = await sql<
    { id: string; name: string | null; base_model: string; chunk_size: number; chunk_overlap: number; top_k: number }[]
  >`
    select distinct c.id, c.name, c.base_model, c.chunk_size, c.chunk_overlap, c.top_k, c.tab_order, c.created_at
    from configs c
    join document_embeddings de on de.config_id = c.id
    join eval_labels l on l.document_embedding_id = de.id
    where c.user_id = ${activeUserId()}
    order by c.tab_order, c.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    label: r.name ?? `${r.base_model} · ${r.chunk_size}/${r.chunk_overlap}`,
    baseModel: r.base_model,
    topK: r.top_k,
  }));
}

// The replay for one config: cached rows when the inputs haven't changed,
// otherwise a fresh computation (~3s, dominated by pulling vectors) that is then
// stored. Candidate models are every registry entry — under-covered ones come
// back listed but unscored rather than dropped.
export async function replayConfig(
  configId: string,
  baseModel: string,
  label: string,
  topK: number,
): Promise<ReplayReport> {
  const corpus = await loadCorpus(configId, baseModel, topK);
  const fp = await fingerprint(configId, corpus);

  let rows = await readCached(configId, fp);
  const fromCache = rows !== null;
  if (!rows) {
    rows = [];
    for (const model of Object.keys(EMBEDDING_MODELS)) {
      rows.push(await scoreModel(model, corpus));
    }
    await writeCached(configId, fp, rows);
  }

  // MRR desc; unscorable models (null MRR) last, then by coverage so the
  // closest-to-usable sit highest among them.
  rows.sort((a, b) => {
    if (a.mrr === null && b.mrr === null) return b.coverageChunks - a.coverageChunks;
    if (a.mrr === null) return 1;
    if (b.mrr === null) return -1;
    return b.mrr - a.mrr;
  });

  return {
    configId,
    configLabel: label,
    corpusChunks: corpus.chunks.length,
    questions: corpus.labels.length,
    rows,
    fromCache,
  };
}

// Replays for every scorable config. One section per config on the page: a
// replay is defined by a corpus AND its chunking, so configs can't be merged.
export async function listReplays(): Promise<ReplayReport[]> {
  const configs = await replayableConfigs();
  const out: ReplayReport[] = [];
  for (const c of configs) {
    out.push(await replayConfig(c.id, c.baseModel, c.label, c.topK));
  }
  return out;
}
