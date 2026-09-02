// GRADED-nDCG RANKING BUILDER (/eval).
//
// A question's nDCG is only meaningful against a GRADED ideal ranking of several
// chunks (a single ground-truth chunk makes IDCG=1). We build that ranking
// synthetically and let the user pick which one is ground truth:
//
//   1. embed the question under the active model
//   2. pull a bounded candidate pool — the top-N chunks by config-filtered HNSW
//      search over the whole active corpus, i.e. the same neighbourhood live
//      retrieval searches
//   3. AGGREGATE: rank the pool under several embedding models, average the
//      per-model ranks -> one ideal order (the cross-model consensus)
//   4. optional LLM rankings as a comparison: rank the pool ('llm_pool'), or
//      re-order the aggregate's top-k ('llm_rerank')
//   5. optional MANUAL order the user hand-edits
//
// Each is stored as an eval_rankings row. The user promotes ONE to is_truth; that's
// what nDCG scores the active model's retrieval against. Pool re-embedding goes
// through embedCache — nothing here touches the chunks_<model>_<dim> tables, so the
// alternate models never enter the live index.
import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "@/lib/config";
import { readLlmRankings } from "@/lib/demo/replay";
import { questionIdentity } from "@/lib/demo/replayCore";
import {
  canonicalModelOrder,
  keyedModels,
  EMBEDDING_MODELS,
} from "@/lib/rag/embeddingModels";
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import { availableProviders } from "@/lib/rag/providerAvailability";
import { getActiveCriteria } from "@/lib/rag/evalSettingsStore";
import { activeConfig } from "@/lib/rag/activeConfig";
import { meteredMessage } from "@/lib/rag/meter";
import { cosine, embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
import { scoreQuestionNow, scoreQuestions, type EvalEvent } from "@/lib/rag/eval";
import {
  allLabeledQuestions,
  createRunSnapshot,
  getSummary,
  questionsNeedingScoring,
} from "@/lib/rag/evalStore";
import { ndcg } from "@/lib/rag/evalMetrics";
import {
  getQuestionScope,
  getRankingChunks,
  getRetrievedOrder,
  listRankings,
  listRankingsByQuestions,
  poolNearest,
  setTruth,
  truthKindByQuestion,
  upsertRanking,
  type RankingKind,
  type StoredRanking,
} from "@/lib/rag/rankingStore";

// One chunk in a ranking, resolved for display in ideal order.
export type RankingItem = {
  chunkId: string;
  fileName: string;
  position: number | null;
  preview: string;
  // Aggregate provenance: this chunk's 1-based rank under each embedding model.
  perModelRanks?: Record<string, number>;
};

// A stored ranking resolved to its chunks + provenance, for the panel.
export type RankingCandidate = {
  id: string;
  kind: RankingKind;
  isTruth: boolean;
  createdAt: number;
  items: RankingItem[];
  models?: string[]; // aggregate: the models averaged
  llmModel?: string; // llm_*: the model that ranked
  // nDCG@k the active model's retrieval would score if THIS ranking were ground
  // truth — a preview of promoting it. Null when the question is unscored.
  ndcg?: number | null;
  // manual only: the ranking kind this hand-edit was derived from, so the panel
  // can render it in that ranking's place and fold the original away.
  derivedFromKind?: RankingKind;
};

// Whether an LLM ranking of a given kind exists and is still current. 'fresh' = a
// cached row whose inputs are unchanged (re-requesting is a no-op, so the panel
// disables it); 'stale' = inputs changed since it was built (offer a rebuild).
export type LlmStatus = "none" | "fresh" | "stale";

// Everything the panel needs on open: the question and the rankings built so far
// (with which is ground truth). The pool is drawn from the whole active corpus,
// so there is nothing to pick before building.
export type RankingContext = {
  questionId: string;
  question: string;
  k: number;
  candidates: RankingCandidate[];
  hasAggregate: boolean; // gates the LLM/manual steps, which reuse the aggregate pool
  llmStatus: { pool: LlmStatus; rerank: LlmStatus };
};

const PREVIEW_CHARS = 160;

// Resolve a stored ranking's chunk ids (ideal order) to display items, pulling
// text in one query. Stale ids (config changed since build) resolve to a "?".
// `retrievedOrder` (the active model's retrieval) lets us preview the nDCG this
// ranking would score as ground truth; pass [] (unscored) for a null score.
async function resolve(
  stored: StoredRanking,
  retrievedOrder: string[] = [],
): Promise<RankingCandidate> {
  const chunks = await getRankingChunks(stored.chunkIds);
  const perModelRanks = stored.details.perModelRanks as
    | Record<string, Record<string, number>>
    | undefined;
  const items: RankingItem[] = stored.chunkIds.map((id) => {
    const c = chunks.get(id);
    return {
      chunkId: id,
      fileName: c?.fileName ?? "?",
      position: c?.position ?? null,
      preview: (c?.text ?? "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
      perModelRanks: perModelRanks?.[id],
    };
  });
  return {
    id: stored.id,
    kind: stored.kind,
    isTruth: stored.isTruth,
    createdAt: stored.createdAt,
    items,
    models: stored.details.models as string[] | undefined,
    llmModel: stored.details.llmModel as string | undefined,
    ndcg: retrievedOrder.length > 0 ? ndcg(stored.chunkIds, retrievedOrder, activeConfig().topK) : null,
    derivedFromKind: stored.details.derivedFromKind as RankingKind | undefined,
  };
}

// --- LLM-ranking cache key -------------------------------------------------
// Bump when LLM_SYSTEM_PROMPT changes meaningfully: it's part of the signature,
// so a bump makes existing cached LLM rankings read 'stale' and rebuild against
// the new prompt instead of silently serving an answer from the old one.
const LLM_PROMPT_VERSION = 1;

// The candidate chunk ids an LLM variant ranks: 'pool' ranks the aggregate's top
// rankingLlmPoolSize; 'rerank' re-orders just its top-k. One place so the cache
// signature and the actual LLM call always slice the aggregate identically.
function llmPoolIds(aggregateChunkIds: string[], variant: "pool" | "rerank"): string[] {
  return variant === "pool"
    ? aggregateChunkIds.slice(0, config.rankingLlmPoolSize)
    : aggregateChunkIds.slice(0, activeConfig().topK);
}

// Fingerprint of an LLM ranking's inputs, so a repeat request serves the cached
// row (no spend) when nothing that affects the answer changed, and recomputes
// when it did. Chunk *ids* capture the text too — chunks are immutable per id
// under a config (re-chunking mints new ids, and a config change re-scopes the
// row). Covers: llm model, prompt version, variant, question text, and the exact
// ordered candidate set sent to the model.
function llmSignature(
  variant: "pool" | "rerank",
  question: string,
  poolIds: string[],
): string {
  const payload = JSON.stringify({
    llmModel: activeConfig().llmModel,
    promptVersion: LLM_PROMPT_VERSION,
    variant,
    question,
    poolIds,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Panel context. Null when the question has no label under the active config.
export async function getRankingContext(
  questionId: string,
): Promise<RankingContext | null> {
  const scope = await getQuestionScope(questionId);
  if (!scope) return null;

  const [stored, scored] = await Promise.all([
    listRankings(questionId),
    getRetrievedOrder(questionId),
  ]);

  // Populate the per-candidate nDCG on demand: once the question has a ground
  // truth (which implies it has a ranking) but no score yet, score it now so the
  // numbers fill in immediately rather than waiting for a bulk "Re-score all".
  let retrievedOrder = scored;
  if (retrievedOrder.length === 0 && stored.some((r) => r.isTruth)) {
    await scoreQuestionNow(questionId);
    retrievedOrder = await getRetrievedOrder(questionId);
  }

  const candidates = await Promise.all(stored.map((s) => resolve(s, retrievedOrder)));

  // Per-LLM-kind freshness, by re-deriving the signature from the CURRENT aggregate
  // (no LLM/embeds) and comparing it to the stored one. Drives the panel's
  // Rank/Cached/Rebuild button state. 'stale' for pre-signature rows (undefined).
  const aggregate = stored.find((r) => r.kind === "aggregate");
  const llmStatusFor = (variant: "pool" | "rerank"): LlmStatus => {
    const kind: RankingKind = variant === "pool" ? "llm_pool" : "llm_rerank";
    const row = stored.find((r) => r.kind === kind);
    if (!row) return "none";
    if (!aggregate) return "stale";
    const expected = llmSignature(
      variant,
      scope.question,
      llmPoolIds(aggregate.chunkIds, variant),
    );
    return row.details.signature === expected ? "fresh" : "stale";
  };

  return {
    questionId,
    question: scope.question,
    k: activeConfig().topK,
    candidates,
    hasAggregate: candidates.some((c) => c.kind === "aggregate"),
    llmStatus: { pool: llmStatusFor("pool"), rerank: llmStatusFor("rerank") },
  };
}

// Step 3: build the cross-model aggregate ranking over the whole active corpus.
// Throws on a stale question / empty pool so the route can surface it.
export // Which models vote in this config's ideal ranking (migration 0045).
// Settings → Metrics → nDCG → "Models in aggregate" overrides the default. Three
// guards, all of which fall back rather than fail:
//   - unkeyed models are dropped (same rule as autotune)
//   - an unknown id (registry entry removed since it was saved) is dropped
//   - an empty result falls back to the default set — an aggregate with no voters
//     can't produce a ranking, and silently building nothing would look broken
//
// Order is canonical (registry order), never the saved click order, so the same
// selection always yields the same ideal.
async function aggregateModels(): Promise<string[]> {
  const criteria = await getActiveCriteria();
  const saved = criteria.ndcg.aggregateModels;
  // null = every keyed model (the default since the hard-coded four were
  // retired — see lib/config). A saved list pins a narrower set.
  const availability = await availableProviders();
  const chosen = saved === null ? keyedModels(availability) : saved;
  const usable = canonicalModelOrder(
    chosen.filter((id) => EMBEDDING_MODELS[id] && availability.has(EMBEDDING_MODELS[id].provider)),
  );
  // A saved list that no longer resolves to anything keyed falls back to the
  // default rather than building a ranking with no voters.
  return usable.length > 0 ? usable : canonicalModelOrder(keyedModels(availability));
}

export async function buildAggregateRanking(
  questionId: string,
): Promise<RankingCandidate> {
  const t0 = performance.now();
  const scope = await getQuestionScope(questionId);
  if (!scope) throw new Error("Question has no label under the active config.");

  // The active-model question vector drives the ANN itself and the pool's
  // nearest-to-question ordering (the indexed chunk vectors are active-model).
  const models = await aggregateModels();
  const activeVec = await embedQueryCached(scope.question, activeConfig().embeddingModel);
  const pool = await poolNearest(activeVec, config.rankingPoolSize);
  if (pool.length === 0) {
    throw new Error("No candidate chunks found — ingest documents under this config first.");
  }

  // Rank the pool under each model; accumulate per-chunk rank sums + provenance.
  const perModelRanks: Record<string, Record<string, number>> = {};
  const rankSum = new Map<string, number>();
  const activeSim = new Map(pool.map((p) => [p.chunkId, p.similarity]));
  for (const p of pool) perModelRanks[p.chunkId] = {};

  // Score every model CONCURRENTLY. Each model is an independent pair of embed
  // calls (query + pool) against a different provider space, and running them in
  // series was the dominant latency of a build — the non-base models have nothing
  // to say to each other.
  const scoredByModel = await Promise.all(
    models.map(async (model) => {
      if (model === activeConfig().embeddingModel) {
        // Already have these similarities from poolNearest — no re-embed.
        return pool.map((p) => ({ chunkId: p.chunkId, sim: p.similarity }));
      }
      const [qVec, docVecs] = await Promise.all([
        embedQueryCached(scope.question, model),
        embedDocsCached(
          pool.map((p) => p.text),
          model,
        ),
      ]);
      return pool.map((p, i) => ({ chunkId: p.chunkId, sim: cosine(qVec, docVecs[i]) }));
    }),
  );

  // Accumulate in the resolved models' DECLARED order, never completion order.
  // rankSum is the primary sort key below and its ties fall through to a
  // secondary key, so the same inputs must always fold in the same sequence for
  // the same ideal to come out — a build whose models finished in a different
  // order must not produce a different ranking. Promise.all preserves index
  // order, so scoredByModel[i] is model i's result whenever it resolved.
  models.forEach((model, i) => {
    const scored = scoredByModel[i];
    scored.sort((a, b) => b.sim - a.sim);
    scored.forEach((s, idx) => {
      const rank = idx + 1;
      perModelRanks[s.chunkId][model] = rank;
      rankSum.set(s.chunkId, (rankSum.get(s.chunkId) ?? 0) + rank);
    });
  });

  // Ideal order = ascending average rank; ties broken by active-model similarity.
  const order = pool
    .map((p) => p.chunkId)
    .sort((a, b) => {
      const ra = rankSum.get(a)! - rankSum.get(b)!;
      return ra !== 0 ? ra : (activeSim.get(b) ?? 0) - (activeSim.get(a) ?? 0);
    });

  const id = await upsertRanking({
    questionId,
    documentEmbeddingId: scope.documentEmbeddingId,
    kind: "aggregate",
    chunkIds: order,
    details: {
      models,
      perModelRanks,
    },
  });

  console.log(
    `[rag:ranking] aggregate q=${questionId.slice(0, 8)} pool=${pool.length} ` +
      `models=${models.length} in ${Math.round(performance.now() - t0)}ms`,
  );
  return resolve(await pickStored(questionId, id));
}

const LlmOrder = z.array(z.number().int().positive());

const LLM_SYSTEM_PROMPT = `You rank document chunks by how well each ANSWERS a question.

You'll get a question and a numbered list of chunks. Order the chunk numbers from
MOST to LEAST relevant to the question. Judge only by the text shown; a chunk that
doesn't help the question should go last. Include every chunk number exactly once.

Respond with ONLY a JSON array of the chunk numbers in your ranked order, no prose
and no code fences, e.g. [3,1,5,2,4]`;

// Step 4: an LLM ranking of the aggregate's pool, as a comparison to the
// embedding consensus. 'pool' ranks a cost-bounded subset of the pool; 'rerank'
// re-orders just the aggregate's top-k. Requires an existing aggregate.
export async function buildLlmRanking(
  questionId: string,
  variant: "pool" | "rerank",
): Promise<RankingCandidate> {
  const scope = await getQuestionScope(questionId);
  if (!scope) throw new Error("Question has no label under the active config.");

  const rankings = await listRankings(questionId);
  const aggregate = rankings.find((r) => r.kind === "aggregate");
  if (!aggregate) throw new Error("Build the aggregate ranking first.");

  const kind: RankingKind = variant === "pool" ? "llm_pool" : "llm_rerank";
  const poolIds = llmPoolIds(aggregate.chunkIds, variant);
  const signature = llmSignature(variant, scope.question, poolIds);

  // Cache hit: a ranking of this kind whose inputs are unchanged. Serve it without
  // calling the LLM — this is what stops a repeat click from spending again.
  const cached = rankings.find((r) => r.kind === kind);
  if (cached && cached.details.signature === signature) {
    console.log(`[rag:ranking] llm ${variant} q=${questionId.slice(0, 8)} cache hit`);
    return resolve(cached);
  }

  // Whole text: these chunks go into the LLM prompt, not onto a screen, so a
  // preview-length read would change what the ranker is asked to judge.
  const chunks = await getRankingChunks(poolIds, { fullText: true });

  const numbered = poolIds.map((id, i) => {
    const c = chunks.get(id);
    const text = (c?.text ?? "").replace(/\s+/g, " ").trim();
    return `${i + 1}. (${c?.fileName ?? "?"}#${c?.position ?? "?"}) ${text}`;
  });

  const response = await meteredMessage("ndcg_ranking", {
    model: activeConfig().llmModel,
    max_tokens: 512,
    system: LLM_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Question: ${scope.question}\n\nChunks:\n${numbered.join("\n")}`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("LLM ranker returned no text content.");
  const parsed = LlmOrder.parse(JSON.parse(jsonArrayIn(block.text)));

  // Map 1-based chunk numbers back to ids, keeping the LLM's order; dedupe and
  // drop out-of-range numbers. Chunks the LLM omits are simply absent from the
  // ideal ranking (gain 0) — that's the LLM judging them irrelevant.
  const seen = new Set<number>();
  const order: string[] = [];
  for (const n of parsed) {
    if (n < 1 || n > poolIds.length || seen.has(n)) continue;
    seen.add(n);
    order.push(poolIds[n - 1]);
  }
  if (order.length === 0) throw new Error("LLM ranking did not reference any chunk.");

  const id = await upsertRanking({
    questionId,
    documentEmbeddingId: scope.documentEmbeddingId,
    kind,
    chunkIds: order,
    details: {
      llmModel: activeConfig().llmModel,
      variant,
      basedOnAggregateId: aggregate.id,
      signature,
    },
  });
  return resolve(await pickStored(questionId, id));
}

// Step 5: persist a hand-edited order. Drops ids not in the active corpus so a
// stale selection just yields a shorter ranking rather than an error.
export async function setManualRanking(
  questionId: string,
  orderedChunkIds: string[],
  derivedFromKind?: RankingKind,
): Promise<RankingCandidate> {
  const scope = await getQuestionScope(questionId);
  if (!scope) throw new Error("Question has no label under the active config.");
  const known = await getRankingChunks(orderedChunkIds);
  const order = orderedChunkIds.filter((id) => known.has(id));
  if (order.length === 0) throw new Error("None of those chunks are in the active corpus.");

  const id = await upsertRanking({
    questionId,
    documentEmbeddingId: scope.documentEmbeddingId,
    kind: "manual",
    chunkIds: order,
    // derivedFromKind lets the panel render this edit in the source's slot and
    // fold the original; omitted (undefined drops from JSON) for an edit of the
    // manual itself, which folds nothing.
    details: { source: "manual", derivedFromKind },
  });
  return resolve(await pickStored(questionId, id));
}

// --- the demo's replay of the two rankings a guest may not buy --------------
//
// Phase 5 of docs/demo-real-flow-plan.md. Both of the builders above spend on a
// provider — the aggregate embeds a 30-chunk pool under every model on the list,
// the LLM re-rank costs one answer-model call — and both are steps of the demo's
// walk. So a published build banks the master's own answers (0082,
// lib/demo/captureRankings) and these two write them into the guest's workspace
// as ordinary eval_rankings rows.
//
// THEY ARE ORDINARY ROWS ON PURPOSE. Nothing downstream is taught about the
// replay: the drilldown resolves them, setTruth promotes them, and the nDCG the
// Eval tab prints is ndcg(ideal, retrieved_ids, k) over the visitor's OWN
// retrieval, computed here and not banked. What the visitor did not do is build
// the ranking — which is the sentence the UI owes them, and the reason these are
// named `replay*` rather than folded into the builders they stand in for.
//
// NULLS ARE KEPT IN THE IDEAL and dropped from the LLM order, which is the same
// distinction clone step 5i draws. In the ideal, position is rank, so an id that
// failed the clone's remap has to hold its place or every chunk behind it is
// promoted; in an llm_rerank it is a comparison candidate list, and buildLlmRanking
// itself already drops chunks the model omitted.
export async function replayAggregateRanking(
  questionId: string,
  order: (string | null)[],
): Promise<string> {
  const scope = await getQuestionScope(questionId);
  if (!scope) throw new Error("Question has no label under the active config.");
  if (order.length === 0) throw new Error("The published ideal for that question is empty.");
  return upsertRanking({
    questionId,
    documentEmbeddingId: scope.documentEmbeddingId,
    kind: "aggregate",
    chunkIds: order as string[],
    // NO perModelRanks, deliberately. The panel renders per-model provenance for
    // an aggregate it built, and this workspace did not rank anything under any
    // model — carrying the master's columns would be a measurement implying a
    // computation that did not happen here. `source` is what the demo's own
    // wording keys off.
    details: { source: "published" },
  });
}

export async function replayLlmRerank(
  questionId: string,
  order: (string | null)[],
): Promise<string> {
  const scope = await getQuestionScope(questionId);
  if (!scope) throw new Error("Question has no label under the active config.");
  const rankings = await listRankings(questionId);
  const aggregate = rankings.find((r) => r.kind === "aggregate");
  if (!aggregate) throw new Error("Build the aggregate ranking first.");
  const chunkIds = order.filter((id): id is string => id !== null);
  if (chunkIds.length === 0) throw new Error("The published LLM ranking for that question is empty.");
  return upsertRanking({
    questionId,
    documentEmbeddingId: scope.documentEmbeddingId,
    kind: "llm_rerank",
    chunkIds,
    // The SIGNATURE is recomputed here rather than banked, and it has to be: it
    // covers the pool ids, which are this workspace's own, and the point of it is
    // that a repeat press reads 'fresh' and spends nothing. The master's copy
    // would name the master's chunks and read permanently stale.
    details: {
      llmModel: activeConfig().llmModel,
      variant: "rerank",
      basedOnAggregateId: aggregate.id,
      source: "published",
      signature: llmSignature("rerank", scope.question, llmPoolIds(aggregate.chunkIds, "rerank")),
    },
  });
}

// Promote one ranking to ground truth (clears any previous truth for the
// question/config). Returns false when the ranking id doesn't resolve.
export async function setOfficialRanking(
  questionId: string,
  rankingId: string,
): Promise<boolean> {
  const scope = await getQuestionScope(questionId);
  if (!scope) return false;
  return setTruth(questionId, scope.documentEmbeddingId, rankingId);
}

// "Bulk actions → Add nDCG rankings": for every labeled question in scope with NO
// ground truth yet, run the same aggregate builder the per-question panel uses and
// promote the result, then score whatever is still unscored. Questions that already
// have a truth are untouched — a manual/LLM choice shouldn't be clobbered by a bulk
// pass. Per-question failures are streamed and skipped rather than aborting.
//
// `rebuild` means "the CORPUS changed": it ALSO refreshes questions whose truth is
// the aggregate, so chunks ingested after their ideal was built can enter it. A
// manual/LLM truth is still left alone. A rebuild re-scores everything it rebuilt,
// in that order: the new chunk enters the ideal FIRST, so re-scored retrieval that
// now surfaces it scores real gain instead of 0 against a stale ideal.
//
// Modest concurrency: each build already fans its aggregate models out in parallel,
// so keeping this low stops a bulk pass from multiplying that into a provider
// rate-limit. The shared embed caches upsert idempotently.
const BULK_RANKING_CONCURRENCY = 2;

export async function bulkBuildRankings(
  emit: (event: EvalEvent) => void = () => {},
  documentIds?: string[],
  rebuild = false,
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<{ graded: number; scored: number }> {
  const t0 = performance.now();
  const questions = await allLabeledQuestions(documentIds);
  const truthKinds = await truthKindByQuestion(questions.map((q) => q.questionId));
  // Ungraded questions build in both modes; an aggregate truth is refreshed only
  // on rebuild; a manual/LLM truth is never touched by a bulk pass.
  const pending = questions.filter((q) => {
    const kind = truthKinds.get(q.questionId);
    if (!kind) return true;
    return rebuild && kind === "aggregate";
  });

  emit({ type: "ranking-start", total: pending.length });

  const gradedIds = new Set<string>();
  let done = 0;
  let nextIndex = 0;
  const worker = async () => {
    for (let i = nextIndex++; i < pending.length; i = nextIndex++) {
      // Checkpoint: between questions. Every ranking already promoted stays —
      // this run's transaction still commits (lib/http/cancelRegistry.ts).
      if (shouldStop()) break;
      const q = pending[i];
      let ok = true;
      let error: string | undefined;
      try {
        const candidate = await buildAggregateRanking(q.questionId);
        if (!(await setOfficialRanking(q.questionId, candidate.id))) {
          throw new Error("Could not promote the ranking to ground truth.");
        }
        gradedIds.add(q.questionId);
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : "Ranking build failed.";
      }
      done += 1;
      emit({
        type: "ranking-progress",
        done,
        total: pending.length,
        questionId: q.questionId,
        ok,
        error,
      });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(BULK_RANKING_CONCURRENCY, pending.length) },
      worker,
    ),
  );

  // On a plain grade, only NEWLY-graded-but-never-scored questions need scoring
  // (already-scored ones read their nDCG live from the stored result the moment
  // a truth exists). On a rebuild, re-score EVERY question we rebuilt so its
  // stored retrieval reflects the topped-up corpus too — otherwise the ideal is
  // current but the retrieval still predates the new docs, and the drift badge's
  // re-score half stays lit.
  // Cancelling the grading half skips the scoring half rather than scoring what
  // landed: the questions graded so far are left pending for "Score pending".
  const cancelled = shouldStop();
  const toScore = cancelled
    ? []
    : rebuild
      ? questions.filter((q) => gradedIds.has(q.questionId))
      : (await questionsNeedingScoring()).filter((q) => gradedIds.has(q.questionId));
  const scored = await scoreQuestions(toScore, emit, shouldStop);

  const summary = await getSummary();
  if (gradedIds.size > 0 || scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      ndcgCovered: summary.ndcgCovered,
      k: summary.recallK,
    });
  }

  console.log(
    `[rag:ranking] bulk graded=${gradedIds.size}/${pending.length} scored=${scored} ` +
      `in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    cancelled,
    generated: 0,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
    graded: gradedIds.size,
  });
  return { graded: gradedIds.size, scored };
}

// "Bulk actions → Add LLM nDCG rankings": build the llm_rerank ranking for every
// labeled question in scope, as a COMPARISON candidate. Nothing is promoted to
// ground truth — that stays an explicit per-question action, so a bulk pass can
// never silently redefine what nDCG scores against.
//
// This spends real LLM tokens per question, so the plan phase is about NOT
// spending. Two skips, both counted and streamed:
//   - no aggregate: llm_rerank re-orders the aggregate's top-k, so there is nothing
//     to re-rank. Run "Add nDCG rankings" first.
//   - cached: an llm_rerank whose stored signature still matches the current inputs.
//     buildLlmRanking would serve it from cache anyway; skipping up front keeps the
//     progress bar's total honest about what actually costs money.
//
// Per-question failures are streamed and skipped: a garbled reply on one question
// shouldn't waste the spend already made on the rest.
//
// AND IN THE DEMO IT SPENDS NOTHING (§4.5 of docs/demo-real-flow-plan.md): the
// publish bought these orders once on the master and banked them (0082), so a
// guest's press applies replayLlmRerank per question instead of calling the
// model. The plan phase above is unchanged and still does its job — a question
// with no aggregate has nothing to re-rank whether the order is bought or
// replayed, and a fresh signature still means the press is a no-op. Only the
// paid call in the worker is swapped, and a stocked shelf never falls back to it.
const BULK_LLM_RANKING_CONCURRENCY = 2;

export async function bulkBuildLlmRankings(
  emit: (event: EvalEvent) => void = () => {},
  documentIds?: string[],
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<{ built: number; skippedNoAggregate: number; skippedCached: number }> {
  const t0 = performance.now();
  const questions = await allLabeledQuestions(documentIds);
  const rankingsByQuestion = await listRankingsByQuestions(
    questions.map((q) => q.questionId),
  );
  // Null for every account but a demo guest, and for a guest whose build shipped
  // without the shelf — the route is what refuses that second case.
  const banked = await readLlmRankings();

  // Plan: partition into "will call the LLM" vs. the two skip reasons. The
  // freshness test re-derives the signature exactly as getRankingContext's
  // llmStatus does, so the bulk pass and the per-question panel agree on which
  // rankings are cached.
  const pending: typeof questions = [];
  let skippedNoAggregate = 0;
  let skippedCached = 0;
  for (const q of questions) {
    const rows = rankingsByQuestion.get(q.questionId) ?? [];
    const aggregate = rows.find((r) => r.kind === "aggregate");
    if (!aggregate) {
      skippedNoAggregate += 1;
      continue;
    }
    const existing = rows.find((r) => r.kind === "llm_rerank");
    const expected = llmSignature(
      "rerank",
      q.question,
      llmPoolIds(aggregate.chunkIds, "rerank"),
    );
    if (existing && existing.details.signature === expected) {
      skippedCached += 1;
      continue;
    }
    pending.push(q);
  }

  emit({
    type: "ranking-start",
    total: pending.length,
    skippedNoAggregate,
    skippedCached,
  });

  let built = 0;
  let done = 0;
  let nextIndex = 0;
  const worker = async () => {
    for (let i = nextIndex++; i < pending.length; i = nextIndex++) {
      // Checkpoint: between questions, i.e. between paid LLM calls — the whole
      // point of cancelling this particular run.
      if (shouldStop()) break;
      const q = pending[i];
      let ok = true;
      let error: string | undefined;
      try {
        if (banked) {
          const order = banked.get(questionIdentity(q.question));
          if (!order) {
            throw new Error("This workspace was published without an LLM ranking for that question.");
          }
          await replayLlmRerank(q.questionId, order);
        } else {
          await buildLlmRanking(q.questionId, "rerank");
        }
        built += 1;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : "LLM ranking build failed.";
      }
      done += 1;
      emit({
        type: "ranking-progress",
        done,
        total: pending.length,
        questionId: q.questionId,
        ok,
        error,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BULK_LLM_RANKING_CONCURRENCY, pending.length) }, worker),
  );

  // No scoring and no run snapshot: an llm_rerank is a candidate, not a truth,
  // so no question's nDCG moved. The headline numbers ride along unchanged only
  // so the dashboard's summary line can render the same shape as the other runs.
  const summary = await getSummary();
  console.log(
    `[rag:ranking] bulk llm_rerank built=${built}/${pending.length} ` +
      `skipped(no-aggregate)=${skippedNoAggregate} skipped(cached)=${skippedCached} ` +
      `in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    cancelled: shouldStop(),
    generated: 0,
    scored: 0,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
    llmRanked: built,
    skippedNoAggregate,
    skippedCached,
  });
  return { built, skippedNoAggregate, skippedCached };
}

// Re-read a freshly upserted ranking by id (the store returns lists, not single
// rows). Throws if it vanished — only possible under a concurrent delete.
async function pickStored(questionId: string, id: string): Promise<StoredRanking> {
  const row = (await listRankings(questionId)).find((r) => r.id === id);
  if (!row) throw new Error("Ranking disappeared after save.");
  return row;
}

// Models occasionally wrap JSON in ```json fences despite instructions; strip them.
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// THE RANKER'S REPLY, WHICH IS NOT ALWAYS ONLY THE ARRAY the prompt asks for.
// Measured while capturing the demo's re-rankings (phase 5 of
// docs/demo-real-flow-plan.md): 4 of 60 questions came back as "Looking at these
// chunks…" with the array underneath, and the same 4 did it again on a retry — so
// it is a property of those questions rather than a flake worth re-buying. Every
// one of them was a perfectly good ranking thrown away over a preamble.
//
// So: fences first, as before, and then the first bracketed run in what is left,
// ALWAYS — not only when the reply fails to start with one. The last of the four
// held out through a retry by putting its commentary AFTER a perfectly good
// array, which is a parse error at position 16 rather than at position 0 and is
// the same defect from the other end.
//
// Deliberately the first bracketed run and not the longest: a reply that talks
// around its answer still puts the answer somewhere, and the array is the only
// bracketed thing this prompt can produce. Still parsed and schema-checked
// afterwards, so a stray "[1, 2]" inside prose fails exactly as it did before
// rather than being trusted for looking like an array.
function jsonArrayIn(text: string): string {
  const stripped = stripFences(text);
  return /\[[^[\]]*\]/.exec(stripped)?.[0] ?? stripped;
}
