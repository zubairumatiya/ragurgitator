// ---------------------------------------------------------------------------
// QUERY TIME, STEP 1: RETRIEVE
//
// Given the user's question, find the most relevant chunks in the active config.
//
// Fast path (no per-chunk overrides): a single config-filtered ANN on the base
// model — unchanged from before.
//
// When the config has per-chunk model OVERRIDES (Phase 5), retrieval fuses
// multiple embedding spaces by a RANK-INTERLEAVE MERGE (D7): the base-model ANN
// over the NON-overridden chunks, plus — for each override model — that model's
// overridden chunks. Raw cosine isn't comparable across embedding spaces, so we
// combine by RANK, not score. Each chunk carries exactly one rank (from its
// canonical model's space) and the merged order is simply ascending rank: base
// chunks at integer positions, overridden chunks at fractional positions
// strictly between the base candidates they beat and the ones they didn't —
// so the two kinds never tie and no arbitrary tie-break can favour either.
//
// An overridden chunk's rank is NOT its rank among the few other overridden
// chunks (a near-empty list would hand it rank ~1 for every query — a
// structural boost unrelated to relevance). Instead it's ranked against this
// query's REAL competition: the base ANN's candidates re-embedded under the
// override model — the configurable fusion pool is embedded fresh (cached
// persistently, see embedCache/0020), and deeper candidates already in the
// cache join for free, so steady-state cost is one query embedding per
// override model while accuracy grows with the cache. The candidates themselves
// still score only from the base list; the delegate-space sims exist purely to
// POSITION the overridden chunks honestly.
//
// The fusion core (fuseWithOverrides) takes the override state as an argument
// so the model-trial dry-run (lib/rag/eval.runModelTrial) can inject a
// HYPOTHETICAL override and report the exact merged rank a chunk would occupy
// if the trial were applied — the trial and live retrieval share this code and
// cannot drift.
// ---------------------------------------------------------------------------
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  cachedDocVectors,
  cosine,
  embedDocsCached,
  embedQueryCached,
} from "@/lib/rag/embedCache";
import { embedQuery } from "@/lib/rag/embeddings";
import {
  listOverrides,
  overrideEmbeddings,
  type ChunkOverride,
  type OverrideEmbedding,
} from "@/lib/rag/overrideStore";
import { query, queryExcluding, resolveChunks } from "@/lib/rag/vectorStore";
import type { RetrievedChunk } from "@/types/rag";

// Base candidates pulled for fusion when overrides exist (vs the final top-k).
// The auto pool is max(k * FUSION_BASE_FACTOR, 50); the config's
// retrieval_fusion_pool (0027) overrides it, and autotune's trial dry-runs can
// pass their own pool. Either way the pool never drops below k, or the merged
// list couldn't fill the final top-k.
//
// The pool counts PAID embeddings only. The base ANN is actually pulled to a
// deeper max(pool * FUSION_DEEP_FACTOR, FUSION_DEEP_FLOOR): candidates beyond
// the pool join the competition FREE when their embedding under the override
// model is already cached (a cosine against a stored vector — no API call), so
// the effective pool grows toward the deep list as the cache warms. In base
// space every candidate's sim is already known from the ANN, so the whole deep
// list always competes there.
const FUSION_BASE_FACTOR = 4;
const FUSION_POOL_FLOOR = 50;
const FUSION_DEEP_FACTOR = 4;
const FUSION_DEEP_FLOOR = 200;

// The effective fusion pool for a retrieval at depth k. `configured` is a
// caller-supplied pool (autotune's setting); null/undefined falls back to the
// active config's retrieval_fusion_pool, then to the auto formula.
export function effectiveFusionPool(k: number, configured?: number | null): number {
  const pool =
    configured ?? activeConfig().fusionPool ?? Math.max(k * FUSION_BASE_FACTOR, FUSION_POOL_FLOOR);
  return Math.max(k, pool);
}

// One entry of the merged fusion list. `sim` is the chunk's real cosine to the
// query in its CANONICAL space (base model for base chunks, the override model
// for overridden chunks) — informational: honest per-chunk, but not comparable
// across spaces and therefore not monotone with the merged order.
export type FusedCandidate = { id: string; rank: number; sim: number };

// Similarity cutoffs captured during one retrieval and stored with the eval
// result (eval_results.screen_cutoffs, 0028). They let the post-autotune
// dirty screen (eval.rescoreAffectedQuestions) prove "this override change
// cannot have altered this question's stored result" without re-retrieving:
//  - deep: sim of the LAST candidate of the FULL deep base list — a chunk
//    below it never competed in the base lane (as a candidate OR as a
//    competitor for override-space ranking). null when the corpus didn't fill
//    the deep list, or on the no-override fast path (no fusion, no pools).
//  - models[m]: the depth-th strongest competitor sim in model m's space — an
//    override piece scoring below it cannot crack the merged top-depth.
//    Always includes the base model (covers future size-only overrides).
// Only the base-ANN competitor sims count toward models[m] (never fellow
// override pieces): overrides can change between runs, competitors can't
// without changing the fingerprint, so the cutoff stays valid as a bound.
export type ScreenCutoffs = {
  depth: number;
  deep: number | null;
  models: Record<string, number>;
};

// Override state loaded ONCE for a batch of retrievals under the same
// fingerprint (eval scoring re-scores hundreds of questions back-to-back).
// Without it every retrieveForQuery call re-reads the override rows and every
// model's pieces from the DB — the dominant repeat cost of "Re-score all" on
// a warm embedding cache.
export type RetrievalContext = {
  overrides: ChunkOverride[];
  piecesFor: (model: string) => Promise<OverrideEmbedding[]>;
};

export async function buildRetrievalContext(): Promise<RetrievalContext> {
  const overrides = await listOverrides();
  const pieceCache = new Map<string, Promise<OverrideEmbedding[]>>();
  return {
    overrides,
    piecesFor: (model) => {
      let p = pieceCache.get(model);
      if (!p) {
        p = overrideEmbeddings(model);
        pieceCache.set(model, p);
      }
      return p;
    },
  };
}

export async function retrieve(question: string): Promise<RetrievedChunk[]> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Cannot retrieve for an empty question.");
  const vector = await embedQuery(trimmed);
  return retrieveForQuery(trimmed, vector);
}

// Rank-interleave fusion against an explicit override state. Returns the FULL
// merged list (every base candidate + every overridden chunk, ascending rank)
// plus resolved metadata for the base candidates; callers slice/resolve as
// needed. Live retrieval passes the stored overrides; the trial dry-run passes
// a hypothetical set.
//
// ⚠ If you change the SEMANTICS of this merge (rank formula, candidate set,
// what `sim`/score means), bump FUSION_VERSION in overrideStore.ts — that's
// what flags results scored under the old algorithm as stale.
export async function fuseWithOverrides(
  text: string,
  baseVector: number[],
  k: number,
  overrides: ChunkOverride[],
  piecesFor: (model: string) => Promise<OverrideEmbedding[]>,
  // Fusion pool override (0027) — autotune's trial dry-runs pass their own;
  // omitted = the config's retrieval_fusion_pool, then the auto formula.
  pool?: number | null,
): Promise<{
  merged: FusedCandidate[];
  meta: Map<string, { documentId: string; position: number; text: string }>;
  cutoffs: ScreenCutoffs;
}> {
  const cfg = activeConfig();
  const overriddenIds = overrides.map((o) => o.sourceChunkId);
  const models = [...new Set(overrides.map((o) => o.model))];

  const lists: FusedCandidate[][] = [];
  const meta = new Map<string, { documentId: string; position: number; text: string }>();
  const cutoffModels: Record<string, number> = {};

  // Base space: ANN over the non-overridden chunks. Pulled past the paid pool
  // so already-cached deeper candidates can compete for free (header comment).
  const paidN = effectiveFusionPool(k, pool);
  const deepN = Math.max(paidN * FUSION_DEEP_FACTOR, FUSION_DEEP_FLOOR);
  const baseChunks = await queryExcluding(baseVector, deepN, overriddenIds);
  baseChunks.forEach((rc) =>
    meta.set(rc.chunk.chunk.id, {
      documentId: rc.chunk.chunk.documentId,
      position: rc.chunk.chunk.position,
      text: rc.chunk.chunk.text,
    }),
  );
  lists.push(
    baseChunks.map((rc, i) => ({ id: rc.chunk.chunk.id, rank: i + 1, sim: rc.score })),
  );

  // Override spaces: score each override model's PIECES against the query
  // embedded under that model, collapse to the best (max-cosine) piece per
  // source chunk (a chunk is represented by its strongest piece — hit = any
  // piece in top-k, eval-autotuning-plan §6.3), then rank each overridden chunk
  // among the base candidates re-embedded under the same model. Only the
  // overridden chunks enter the merge list; the competitors just set the bar.
  // Size-only overrides live in base space, so the base vector and the base
  // candidates' ANN scores are reused as-is (no re-embedding).
  for (const model of models) {
    const isBase = model === cfg.embeddingModel;
    const qv = isBase ? baseVector : await embedQueryCached(text, model);
    const pieces = await piecesFor(model);
    const bestByChunk = new Map<string, number>();
    for (const p of pieces) {
      const sim = cosine(qv, p.embedding);
      const prev = bestByChunk.get(p.chunkId);
      if (prev === undefined || sim > prev) bestByChunk.set(p.chunkId, sim);
    }

    // The competition: this query's base candidates, in THIS model's space.
    // Base space → every deep candidate's cosine is its ANN score (free).
    // Otherwise: embed the paid pool under the model (persistent cache), then
    // add whichever DEEPER candidates are already cached — free accuracy that
    // compounds as trials and queries warm the cache.
    let competitorSims: number[];
    if (isBase) {
      competitorSims = baseChunks.map((rc) => rc.score);
    } else {
      const paidTexts = baseChunks.slice(0, paidN).map((rc) => rc.chunk.chunk.text);
      const paidVecs = await embedDocsCached(paidTexts, model);
      competitorSims = paidVecs.map((v) => cosine(qv, v));
      const deeperTexts = baseChunks.slice(paidN).map((rc) => rc.chunk.chunk.text);
      const freeVecs = await cachedDocVectors(deeperTexts, model);
      for (const t of deeperTexts) {
        const vec = freeVecs.get(t);
        if (vec) competitorSims.push(cosine(qv, vec));
      }
    }

    // Screen cutoff for this space: the k-th strongest competitor sim (k = the
    // caller's retrieval depth for eval scoring). Competitor sims only — see
    // ScreenCutoffs.
    const sortedCompetitors = [...competitorSims].sort((a, b) => b - a);
    if (sortedCompetitors.length >= k) cutoffModels[model] = sortedCompetitors[k - 1];

    const overriddenSims = [...bestByChunk.values()];
    lists.push(
      [...bestByChunk.entries()].map(([id, sim]) => ({
        id,
        // Fractional rank: beating m of (competitors + fellow overridden
        // chunks, self ties excluded) places it strictly BETWEEN merged
        // positions m and m+1 — never tying a base chunk's integer rank.
        rank:
          0.5 +
          competitorSims.filter((s) => s > sim).length +
          overriddenSims.filter((s) => s > sim).length,
        sim,
      })),
    );
  }

  // Rank-interleave merge: ascending rank across all lists. Base ranks are
  // unique integers and override ranks are fractional, so cross-kind ties are
  // impossible by construction.
  const merged = lists.flat().sort((a, b) => a.rank - b.rank);

  // Base-model cutoff even when no current override lives in base space, so a
  // FUTURE size-only override can still be screened against this result.
  if (cutoffModels[cfg.embeddingModel] === undefined && baseChunks.length >= k) {
    cutoffModels[cfg.embeddingModel] = baseChunks[k - 1].score;
  }
  const cutoffs: ScreenCutoffs = {
    depth: k,
    // Only a FULL deep list bounds base-lane membership; a shorter one means
    // the whole corpus competed, so nothing can be proven "outside" it.
    deep: baseChunks.length >= deepN ? baseChunks[baseChunks.length - 1].score : null,
    models: cutoffModels,
  };
  return { merged, meta, cutoffs };
}

// Retrieve a query's top results in the active config. `baseVector` is the query
// already embedded under the base model (eval reuses a cached one); override-
// model query vectors are embedded on demand from `text`. `limit` defaults to the
// config's top_k; eval passes a larger superset so one retrieved list can score
// Recall@recall_k and nDCG@ndcg_k at once (A1, see lib/rag/evalSettingsStore).
// `ctx` (batch scoring) supplies pre-loaded override state; omitted = read it.
export async function retrieveForQuery(
  text: string,
  baseVector: number[],
  limit?: number,
  ctx?: RetrievalContext,
): Promise<RetrievedChunk[]> {
  return (await retrieveWithCutoffs(text, baseVector, limit, ctx)).retrieved;
}

// retrieveForQuery plus the ScreenCutoffs this retrieval was judged at — eval
// scoring stores them with the result (0028) for the dirty screen.
export async function retrieveWithCutoffs(
  text: string,
  baseVector: number[],
  limit?: number,
  ctx?: RetrievalContext,
): Promise<{ retrieved: RetrievedChunk[]; cutoffs: ScreenCutoffs }> {
  const cfg = activeConfig();
  const k = limit ?? cfg.topK;
  const overrides = ctx?.overrides ?? (await listOverrides());
  // No overrides → the original single-space ANN. Identical behaviour + cost.
  // deep is null (no fusion pools existed) and the base cutoff is simply the
  // k-th retrieved score.
  if (overrides.length === 0) {
    const retrieved = await query(baseVector, k);
    return {
      retrieved,
      cutoffs: {
        depth: k,
        deep: null,
        models:
          retrieved.length >= k
            ? { [cfg.embeddingModel]: retrieved[k - 1].score }
            : {},
      },
    };
  }

  const { merged, meta, cutoffs } = await fuseWithOverrides(
    text,
    baseVector,
    k,
    overrides,
    ctx?.piecesFor ?? overrideEmbeddings,
  );
  const top = merged.slice(0, k);

  // Override winners weren't in the base ANN (they were excluded) — resolve them.
  const unresolved = top.map(({ id }) => id).filter((id) => !meta.has(id));
  for (const [id, m] of await resolveChunks(unresolved)) meta.set(id, m);

  const retrieved = top.map(({ id, sim }) => {
    const m = meta.get(id);
    return {
      // The chunk's real cosine in its canonical space (base or delegate model).
      // Honest per chunk, but NOT comparable across spaces — the merged rank
      // order is authoritative, so scores here aren't necessarily descending.
      score: sim,
      chunk: {
        embedding: [],
        chunk: {
          id,
          documentId: m?.documentId ?? "",
          text: m?.text ?? "",
          position: m?.position ?? 0,
        },
      },
    };
  });
  return { retrieved, cutoffs };
}
