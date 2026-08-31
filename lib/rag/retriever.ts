// QUERY TIME, STEP 1: RETRIEVE — find the most relevant chunks for a question.
//
// Fast path (no per-chunk overrides): a single config-filtered ANN on the base model.
//
// With overrides, retrieval fuses multiple embedding spaces by a RANK-INTERLEAVE
// MERGE. Raw cosine isn't comparable across embedding spaces, so we combine by
// RANK, not score: each chunk carries exactly one rank (from its canonical
// model's space) and the merged order is ascending rank — base chunks at integer
// positions, overridden chunks at fractional positions strictly between the base
// candidates they beat and the ones they didn't, so the two kinds never tie.
//
// SHARED SPACE ⇒ NO FUSION: an override whose model shares the base model's
// vectorSpace is cosine-comparable to the base query, so its pieces rank by real
// cosine directly against the base candidates, reusing the base query vector.
// Only genuinely FOREIGN spaces open a fusion lane.
//
// An overridden chunk's rank is NOT its rank among the few other overridden
// chunks — a near-empty list would hand it rank ~1 for every query, a structural
// boost unrelated to relevance. It's ranked against this query's REAL
// competition: the base ANN's candidates re-embedded under the override model.
//
// fuseWithOverrides takes the override state as an argument so the model-trial
// dry-run can inject a HYPOTHETICAL override and report the exact merged rank a
// chunk would occupy — trial and live retrieval share this code and cannot drift.
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  cachedDocVectors,
  cosine,
  embedDocsCached,
  embedQueryCached,
  meterEmbeds,
} from "@/lib/rag/embedCache";
import { embedQuery } from "@/lib/rag/embeddings";
import { sameVectorSpace } from "@/lib/rag/embeddingModels";
import {
  listOverrides,
  overrideSims,
  type ChunkOverride,
} from "@/lib/rag/overrideStore";
import { query, queryExcluding, queryExcludingIds, resolveChunks } from "@/lib/rag/vectorStore";
import type { RetrievedChunk } from "@/types/rag";

// Base candidates pulled for fusion when overrides exist (vs the final top-k).
// The auto pool is max(k * FUSION_BASE_FACTOR, 50); the config's
// retrieval_fusion_pool (0027) overrides it. The pool never drops below k, or the
// merged list couldn't fill the final top-k.
//
// The pool counts PAID embeddings only. The base ANN is pulled deeper: candidates
// beyond the pool join FREE when their embedding under the override model is
// already cached, so the effective pool grows toward the deep list as the cache
// warms. In base space every candidate's sim is already known from the ANN.
const FUSION_BASE_FACTOR = 4;
const FUSION_POOL_FLOOR = 50;
const FUSION_DEEP_FACTOR = 4;
const FUSION_DEEP_FLOOR = 200;

// The effective fusion pool at depth k. `configured` is a caller-supplied pool;
// null/undefined falls back to the config's retrieval_fusion_pool, then the auto
// formula.
export function effectiveFusionPool(k: number, configured?: number | null): number {
  const pool =
    configured ?? activeConfig().fusionPool ?? Math.max(k * FUSION_BASE_FACTOR, FUSION_POOL_FLOOR);
  return Math.max(k, pool);
}

// One entry of the merged fusion list. `sim` is the chunk's real cosine in its
// CANONICAL space — informational: honest per-chunk, but not comparable across
// spaces and therefore not monotone with the merged order.
export type FusedCandidate = { id: string; rank: number; sim: number };

// Similarity cutoffs captured during one retrieval and stored with the eval
// result (0028). They let the post-autotune dirty screen prove "this override
// change cannot have altered this question's stored result" without re-retrieving:
//  - deep: sim of the LAST candidate of the FULL deep base list — a chunk below it
//    never competed in the base lane. null when the corpus didn't fill the deep
//    list, or on the no-override fast path.
//  - models[m]: the depth-th strongest competitor sim in model m's space — an
//    override piece scoring below it cannot crack the merged top-depth.
// Only base-ANN competitor sims count toward models[m], never fellow override
// pieces: overrides can change between runs, competitors can't without changing
// the fingerprint, so the cutoff stays valid as a bound.
export type ScreenCutoffs = {
  depth: number;
  deep: number | null;
  models: Record<string, number>;
};

// Override state loaded ONCE for a batch of retrievals under the same fingerprint
// (eval scoring re-scores hundreds of questions back-to-back). Without it every
// retrieveForQuery re-reads the override rows and every model's pieces — the
// dominant repeat cost of "Re-score all" on a warm embedding cache.
export type ChunkMeta = { documentId: string; position: number; text: string };

// The override half of one fusion lane: the best piece sim per overridden chunk
// under `model`, for THIS query. `text` is the query's text and is only a cache
// key — (model, text) determines `qv` the same way annKey below argues it
// determines the base ANN, and a 1024-float key would be absurd.
export type SimsFor = (
  model: string,
  qv: number[],
  text: string,
) => Promise<Map<string, number>>;

export type RetrievalContext = {
  overrides: ChunkOverride[];
  simsFor: SimsFor;
  // Same cross-call caching as simsFor — see resolveCached below.
  resolve: (ids: string[]) => Promise<Map<string, ChunkMeta>>;
};

// A sim is QUERY-dependent, so the cross-call cache that used to hold one entry
// per model — the whole config's vectors, re-downloaded per question at 68.4s —
// no longer has a per-model shape to hold. It is now one entry per (model,
// query), which is a thing that grows without bound if a module-level Map keeps
// it, so it is CALLER-OWNED instead: the memo below lives exactly as long as one
// buildRetrievalContext, the way annCache lives exactly as long as one chunk's
// autotune search (§1.1). The reuse that mattered — autotune asking the SAME
// question across many rungs — is preserved by autotune's own per-chunk memo,
// which is where that repetition actually happens.
//
// Nothing is lost by dropping the fingerprint key here: the read it protected is
// now ~1 kB, and a sim map that is never shared across override states cannot go
// stale.

// The cross-call cache for resolveChunks. A chunk's metadata is a property of the CHUNK
// ROW, which an override never touches, so this could in principle be cached for
// longer. It's keyed on the same fingerprint anyway: one eviction rule means one
// staleness question to reason about instead of two, and the reuse that matters
// (many re-scores under one override state) is captured either way.
// A chunk's metadata is a property of the CHUNK ROW, which an override never
// touches, so this could in principle be cached for longer. It stays keyed on the
// override-state fingerprint anyway: that key can only ever be too CONSERVATIVE,
// and one eviction rule is one staleness question to reason about.
let metaCacheState: string | null = null;
let metaCacheById = new Map<string, ChunkMeta>();

function resetCachesFor(state: string): void {
  if (metaCacheState === state) return;
  metaCacheState = state;
  metaCacheById = new Map();
}

// `state` is the caller's already-fetched fingerprint, passed as a PROMISE so
// callers can keep fetching it in parallel with this function instead of
// serializing behind it (worth ~58s — don't undo it). Omitted → no cross-call
// caching, just the per-context memo.
export async function buildRetrievalContext(
  state?: Promise<string>,
): Promise<RetrievalContext> {
  const overrides = await listOverrides();
  const simCache = new Map<string, Promise<Map<string, number>>>();
  return {
    overrides,
    simsFor: (model, qv, text) => {
      const key = `${model}\0${text}`;
      let p = simCache.get(key);
      if (!p) {
        p = overrideSims(model, qv);
        simCache.set(key, p);
      }
      return p;
    },
    resolve: async (ids) => {
      if (ids.length === 0) return new Map();
      const fingerprint = state ? await state : null;
      if (fingerprint === null) return resolveChunks(ids);
      resetCachesFor(fingerprint);

      // Only unresolved ids go to the database. A partial miss still costs one query,
      // not one per id.
      const out = new Map<string, ChunkMeta>();
      const missing: string[] = [];
      for (const id of ids) {
        const hit = metaCacheById.get(id);
        if (hit) out.set(id, hit);
        else missing.push(id);
      }
      if (missing.length > 0) {
        for (const [id, m] of await resolveChunks(missing)) {
          metaCacheById.set(id, m);
          out.set(id, m);
        }
      }
      return out;
    },
  };
}

export async function retrieve(question: string): Promise<RetrievedChunk[]> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Cannot retrieve for an empty question.");
  // Live chat's base query embed — deliberately UNCACHED (a repeat question is the
  // semantic cache's job, upstream of here), so this is always a miss and only ever
  // reports spend. Metered so the chat surface's embed cost isn't invisible.
  const vector = await embedQuery(trimmed);
  meterEmbeds(activeConfig().embeddingModel, [], [trimmed]);
  return retrieveForQuery(trimmed, vector);
}

// Rank-interleave fusion against an explicit override state. Returns the FULL
// merged list plus whatever metadata the merge happened to have in hand —
// EMPTY unless a foreign-space lane forced the pool's text to be fetched
// (§1.2). Callers slice the merged list and resolve the ids they keep. Live retrieval passes the stored overrides, the trial dry-run a
// hypothetical set.
//
// ⚠ If you change the SEMANTICS of this merge (rank formula, candidate set, what
// `sim`/score means), bump FUSION_VERSION in overrideStore.ts — that's what flags
// results scored under the old algorithm as stale.
export async function fuseWithOverrides(
  text: string,
  baseVector: number[],
  k: number,
  overrides: ChunkOverride[],
  // Best override sim per overridden chunk, per model. Live retrieval passes the
  // SQL-side reader; a dry-run passes one that folds its in-memory candidate
  // vectors into that map (overrideSimMerge.withCandidateSims).
  simsFor: SimsFor,
  // Fusion pool override (0027); omitted = the config's retrieval_fusion_pool, then
  // the auto formula.
  pool?: number | null,
  // A caller-owned cache for the base ANN. Autotune's search re-ranks the SAME
  // question against many candidate rungs, and the base ANN depends only on (query
  // vector, excluded ids, depth) — none of which vary across rungs. Caller-owned
  // because the caller knows the lifetime: one chunk's search, during which no
  // override is persisted. Live retrieval passes nothing.
  annCache?: Map<string, RetrievedChunk[]>,
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

  // Base space: ANN over the non-overridden chunks. Pulled past the paid pool so
  // already-cached deeper candidates can compete for free (see header).
  const paidN = effectiveFusionPool(k, pool);
  const deepN = Math.max(paidN * FUSION_DEEP_FACTOR, FUSION_DEEP_FLOOR);
  // Does anything in this merge actually READ the pool's text? Only a
  // FOREIGN-space override model does: it re-embeds the paid pool and looks the
  // deeper candidates up in cachedDocVectors BY TEXT, so the text is that
  // cache's key and all deepN rows are required (§1.2 — resolving only paidN
  // there would drop the free deeper candidates, i.e. change the candidate set
  // and cost a FUSION_VERSION bump). Every other path wants (id, score) alone,
  // and pays ~480 kB a query for text it discards.
  const needsPoolText = models.some((m) => !sameVectorSpace(m, cfg.embeddingModel));
  // Keyed on everything the ANN result depends on: the query, the excluded set
  // (sorted so ordering can't produce a false miss), the depth, and WHICH of the
  // two reads produced it — a text-free entry must never be served to a call that
  // needs text (a trial can inject a foreign-space model the stored overrides
  // don't have, so this can vary within one annCache's life).
  const annKey = annCache
    ? `${text}\0${deepN}\0${needsPoolText ? "T" : "L"}\0${[...overriddenIds].sort().join(",")}`
    : null;
  const cachedAnn = annKey !== null ? annCache!.get(annKey) : undefined;
  const baseChunks =
    cachedAnn ??
    (needsPoolText
      ? await queryExcluding(baseVector, deepN, overriddenIds)
      : await queryExcludingIds(baseVector, deepN, overriddenIds));
  if (annKey !== null && cachedAnn === undefined) annCache!.set(annKey, baseChunks);
  // Seed `meta` only when the rows actually carry it. On the light path the map
  // starts EMPTY and retrieveForQuery's existing resolveChunks fallback fills the
  // topK that survive — the same path override winners have always taken.
  if (needsPoolText) {
    baseChunks.forEach((rc) =>
      meta.set(rc.chunk.chunk.id, {
        documentId: rc.chunk.chunk.documentId,
        position: rc.chunk.chunk.position,
        text: rc.chunk.chunk.text,
      }),
    );
  }
  lists.push(
    baseChunks.map((rc, i) => ({ id: rc.chunk.chunk.id, rank: i + 1, sim: rc.score })),
  );

  // Override spaces: score each override model's PIECES against the query
  // embedded under that model, collapse to the best (max-cosine) piece per
  // source chunk (a chunk is represented by its strongest piece — hit = any
  // piece in top-k, eval-autotuning-plan §6.3), then rank each overridden chunk
  // among the base candidates re-embedded under the same model. Only the
  // overridden chunks enter the merge list; the competitors just set the bar.
  //
  // BASE-SPACE FOLD: a size-only override, the base model itself, OR any model
  // that shares the base's vectorSpace (sameVectorSpace) produces vectors that
  // are cosine-comparable to the base query — so the base query vector and the
  // base candidates' ANN scores are reused as-is: no query re-embedding, no
  // pool re-embedding, and the override's pieces rank by real cosine in the one
  // base lane. Only a FOREIGN-space model opens a true fusion lane (its own
  // query embedding + pool re-embed). This is the "shared space ⇒ no fusion"
  // saving; changing which models fold changes fused ranks, so it is gated by
  // FUSION_VERSION (overrideStore.ts).
  for (const model of models) {
    const isBaseSpace = sameVectorSpace(model, cfg.embeddingModel);
    const qv = isBaseSpace ? baseVector : await embedQueryCached(text, model);
    // max-cosine over the model's pieces, grouped by source chunk. Computed in
    // Postgres now rather than by downloading every piece vector — same
    // arithmetic, ~300 kB less on the wire (docs/fusion-egress-plan.md §1.1).
    // Treat it as READ-ONLY: it may be a memoized map shared with another call.
    const bestByChunk = await simsFor(model, qv, text);

    // The competition: this query's base candidates, in THIS model's space.
    // Base space (incl. same-space folds) → every deep candidate's cosine is
    // its ANN score (free). Otherwise: embed the paid pool under the model
    // (persistent cache), then add whichever DEEPER candidates are already
    // cached — free accuracy that compounds as trials and queries warm the cache.
    let competitorSims: number[];
    if (isBaseSpace) {
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
    ctx?.simsFor ?? ((model, qv) => overrideSims(model, qv)),
  );
  const top = merged.slice(0, k);

  // Override winners weren't in the base ANN (they were excluded) — resolve them.
  // Through the context when there is one, so repeated re-scores under the same
  // override state don't re-read the same chunk rows (L14).
  const unresolved = top.map(({ id }) => id).filter((id) => !meta.has(id));
  const resolved = ctx ? await ctx.resolve(unresolved) : await resolveChunks(unresolved);
  for (const [id, m] of resolved) meta.set(id, m);

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
