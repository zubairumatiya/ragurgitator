// ---------------------------------------------------------------------------
// GRADED-nDCG RANKING BUILDER (/eval).
//
// A question's nDCG is only meaningful against a GRADED ideal ranking of several
// chunks (a single ground-truth chunk makes IDCG=1, see evalMetrics). We build
// that ranking synthetically and let the user pick which one is ground truth:
//
//   1. embed the question, find the cluster centroids nearest it (a saved preset)
//   2. pull a bounded candidate pool — the chunks in those buckets nearest the
//      question (rankingStore.poolFromBuckets)
//   3. AGGREGATE: rank the pool under several embedding models, average the
//      per-model ranks -> one ideal order (the cross-model consensus)
//   4. optional LLM rankings as a comparison: rank the pool ('llm_pool'), or
//      re-order the aggregate's top-k ('llm_rerank')
//   5. optional MANUAL order the user hand-edits
//
// Each is stored as an eval_rankings row (one per kind per question/config). The
// user promotes ONE to is_truth via setOfficialRanking; that's what nDCG scores
// the active model's retrieval against. Pool re-embedding is in-memory only
// (embedCache) — nothing here touches the chunks_<model>_<dim> tables.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { z } from "zod";
import { config, rankingAggregateModels } from "@/lib/config";
import { activeConfig } from "@/lib/rag/activeConfig";
import { anthropicClient } from "@/lib/llm/client";
import { cosine, embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
import { listRuns, missingDocumentsByRun } from "@/lib/rag/clusterStore";
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
  getTruthOrder,
  listRankings,
  nearestBuckets,
  poolFromBuckets,
  setTruth,
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
  clusterRunId?: string | null; // which preset seeded the pool
  // nDCG@k the active model's retrieval would score if THIS ranking were ground
  // truth — a preview of promoting it. Null when the question is unscored.
  ndcg?: number | null;
  // manual only: the ranking kind this hand-edit was derived from, so the panel
  // can render it in that ranking's place and fold the original away.
  derivedFromKind?: RankingKind;
};

export type RankingPreset = {
  id: string;
  name: string | null;
  k: number;
  chunkCount: number;
  silhouette: number; // run-level, in [-1, 1] — higher = better-separated buckets
  avgCohesion: number; // mean member-to-centroid cosine across all points
  sizes: number[]; // by ordinal — the per-bucket detail shown when expanded
  cohesions: number[]; // by ordinal
  // False when THIS question's document has no chunk in the preset (ingested
  // after it was clustered) — its pool would come from the wrong documents, so
  // the panel warns before a build.
  coversQuestionDoc: boolean;
};

// Whether an LLM ranking of a given kind exists and is still current. 'fresh' = a
// cached row whose inputs are unchanged (re-requesting is a no-op, so the panel
// disables it); 'stale' = inputs changed since it was built (offer a rebuild).
export type LlmStatus = "none" | "fresh" | "stale";

// Everything the panel needs on open: the question, the saved cluster presets to
// seed a pool, and the rankings built so far (with which is ground truth).
export type RankingContext = {
  questionId: string;
  question: string;
  k: number;
  presets: RankingPreset[];
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
    clusterRunId: (stored.details.clusterRunId as string | undefined) ?? null,
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

  const [runs, stored, scored] = await Promise.all([
    listRuns(),
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

  const presets: RankingPreset[] = runs
    .filter((r) => r.saved)
    .map((r) => ({
      id: r.id,
      name: r.name,
      k: r.k,
      chunkCount: r.chunkCount,
      silhouette: r.silhouette,
      avgCohesion: r.avgCohesion,
      sizes: r.sizes,
      cohesions: r.cohesions,
      coversQuestionDoc: !r.missingDocuments.some((d) => d.id === scope.documentId),
    }));
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
    presets,
    candidates,
    hasAggregate: candidates.some((c) => c.kind === "aggregate"),
    llmStatus: { pool: llmStatusFor("pool"), rerank: llmStatusFor("rerank") },
  };
}

// Step 3: build the cross-model aggregate ranking from a saved preset. Throws on
// a stale question / empty pool / unknown preset so the route can surface it.
export async function buildAggregateRanking(
  questionId: string,
  clusterRunId: string,
): Promise<RankingCandidate> {
  const t0 = performance.now();
  const scope = await getQuestionScope(questionId);
  if (!scope) throw new Error("Question has no label under the active config.");

  // The active-model question vector drives both the centroid search and the
  // pool's nearest-to-question ordering (centroids + chunk vectors are active-model).
  const activeVec = await embedQueryCached(scope.question, activeConfig().embeddingModel);
  const buckets = await nearestBuckets(
    clusterRunId,
    activeVec,
    config.rankingNearestBuckets,
  );
  if (buckets.length === 0) {
    throw new Error("That preset has no buckets — pick another or re-run clustering.");
  }
  const pool = await poolFromBuckets(
    buckets.map((b) => b.clusterId),
    activeVec,
    config.rankingPoolSize,
  );
  if (pool.length === 0) {
    throw new Error("No candidate chunks found near this question in that preset.");
  }

  // Rank the pool under each model; accumulate per-chunk rank sums + provenance.
  const perModelRanks: Record<string, Record<string, number>> = {};
  const rankSum = new Map<string, number>();
  const activeSim = new Map(pool.map((p) => [p.chunkId, p.similarity]));
  for (const p of pool) perModelRanks[p.chunkId] = {};

  for (const model of rankingAggregateModels) {
    let scored: { chunkId: string; sim: number }[];
    if (model === activeConfig().embeddingModel) {
      // Already have these similarities from poolFromBuckets — no re-embed.
      scored = pool.map((p) => ({ chunkId: p.chunkId, sim: p.similarity }));
    } else {
      const [qVec, docVecs] = await Promise.all([
        embedQueryCached(scope.question, model),
        embedDocsCached(
          pool.map((p) => p.text),
          model,
        ),
      ]);
      scored = pool.map((p, i) => ({ chunkId: p.chunkId, sim: cosine(qVec, docVecs[i]) }));
    }
    scored.sort((a, b) => b.sim - a.sim);
    scored.forEach((s, idx) => {
      const rank = idx + 1;
      perModelRanks[s.chunkId][model] = rank;
      rankSum.set(s.chunkId, (rankSum.get(s.chunkId) ?? 0) + rank);
    });
  }

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
      clusterRunId,
      bucketOrdinals: buckets.map((b) => b.ordinal),
      models: rankingAggregateModels,
      perModelRanks,
    },
  });

  console.log(
    `[rag:ranking] aggregate q=${questionId.slice(0, 8)} pool=${pool.length} ` +
      `models=${rankingAggregateModels.length} in ${Math.round(performance.now() - t0)}ms`,
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

  const chunks = await getRankingChunks(poolIds);

  const numbered = poolIds.map((id, i) => {
    const c = chunks.get(id);
    const text = (c?.text ?? "").replace(/\s+/g, " ").trim();
    return `${i + 1}. (${c?.fileName ?? "?"}#${c?.position ?? "?"}) ${text}`;
  });

  const response = await anthropicClient.messages.create({
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
  const parsed = LlmOrder.parse(JSON.parse(stripFences(block.text)));

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

// "Bulk actions → Add nDCG rankings → {preset}": for every labeled question in
// scope with NO ground truth yet, run the same aggregate builder the per-question
// panel uses (seeded from the chosen cluster preset) and promote the result to
// ground truth, then score whatever is still unscored so the nDCG chips fill in.
// Questions that already have a truth are untouched — a manual/LLM choice the
// user made shouldn't be clobbered by a bulk pass. Per-question failures are
// reported on the stream and skipped rather than aborting the run.
//
// Modest concurrency: each build fans out to one embed call per aggregate model
// (pool + query), so this is gentler than SCORE_CONCURRENCY; the shared embed
// caches upsert idempotently, so races cost at most a duplicate embed.
const BULK_RANKING_CONCURRENCY = 2;

export async function bulkBuildRankings(
  clusterRunId: string,
  emit: (event: EvalEvent) => void = () => {},
  documentIds?: string[],
): Promise<{ graded: number; scored: number }> {
  const t0 = performance.now();
  const questions = await allLabeledQuestions(documentIds);
  const truths = await getTruthOrder(questions.map((q) => q.questionId));
  const pending = questions.filter((q) => !truths.has(q.questionId));

  // Documents the preset doesn't cover (ingested after it was clustered). Their
  // questions would get candidate pools drawn from the WRONG documents — a
  // worthless ground truth — so they're skipped with a streamed reason instead.
  const missingDocs = new Set(
    ((await missingDocumentsByRun([clusterRunId])).get(clusterRunId) ?? []).map(
      (d) => d.id,
    ),
  );

  emit({ type: "ranking-start", total: pending.length });

  const gradedIds = new Set<string>();
  let done = 0;
  let nextIndex = 0;
  const worker = async () => {
    for (let i = nextIndex++; i < pending.length; i = nextIndex++) {
      const q = pending[i];
      let ok = true;
      let error: string | undefined;
      try {
        if (missingDocs.has(q.documentId)) {
          throw new Error(
            "This question's document isn't in the preset's clusters — re-run clustering and save a new preset.",
          );
        }
        const candidate = await buildAggregateRanking(q.questionId, clusterRunId);
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

  // Newly graded but never scored questions have no retrieved order to grade
  // against — score just those (already-scored ones read their nDCG from the
  // stored result rows the moment the truth exists).
  const needsScore = (await questionsNeedingScoring()).filter((q) =>
    gradedIds.has(q.questionId),
  );
  const scored = await scoreQuestions(needsScore, emit);

  const summary = await getSummary();
  if (gradedIds.size > 0 || scored > 0) {
    await createRunSnapshot({
      questionCount: summary.scored,
      hitCount: summary.hits,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      k: summary.recallK,
    });
  }

  console.log(
    `[rag:ranking] bulk graded=${gradedIds.size}/${pending.length} scored=${scored} ` +
      `in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "done",
    generated: 0,
    scored,
    recall: summary.recall,
    mrr: summary.mrr,
    ndcg: summary.ndcg,
    graded: gradedIds.size,
  });
  return { graded: gradedIds.size, scored };
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
