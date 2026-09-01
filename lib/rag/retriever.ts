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
  cosine,
  diskDocVectorsByHash,
  embedDocsCached,
  embedQueriesCached,
  embedQueryCached,
  meterEmbedHitsByChars,
  meterEmbeds,
} from "@/lib/rag/embedCache";
import { embedQuery } from "@/lib/rag/embeddings";
import { sameVectorSpace } from "@/lib/rag/embeddingModels";
import {
  listOverrides,
  overrideSims,
  overrideSimsBatch,
  type ChunkOverride,
} from "@/lib/rag/overrideStore";
import {
  poolDocSims,
  poolDocSimsBatch,
  query,
  queryBatch,
  queryExcludingIds,
  queryExcludingIdsBatch,
  resolveChunks,
  type PoolDocSim,
} from "@/lib/rag/vectorStore";
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

// The foreign lane's competitor sims for ONE query, by chunk id. Same signature
// as vectorStore.poolDocSims plus the query text, which is only a memo key — the
// (model, text) pair determines `qv` exactly as it does for SimsFor.
export type PoolSimsFor = (
  ids: string[],
  model: string,
  qv: number[],
  text: string,
) => Promise<Map<string, PoolDocSim>>;

// The base lane's ANN for ONE query. `text` is the memo key; everything else is
// what queryExcludingIds takes.
export type AnnFor = (
  text: string,
  vector: number[],
  deepN: number,
  excludeIds: string[],
) => Promise<RetrievedChunk[]>;

export type RetrievalContext = {
  overrides: ChunkOverride[];
  simsFor: SimsFor;
  // Same cross-call caching as simsFor — see resolveCached below.
  resolve: (ids: string[]) => Promise<Map<string, ChunkMeta>>;
  // The two READS that scale with the batch rather than with the query. Both are
  // plain pass-throughs to the single-query store call until prefetchRetrieval
  // has filled their memo — so a context that never prefetches behaves exactly
  // as it did before this existed, one round trip at a time.
  poolSimsFor: PoolSimsFor;
  annFor: AnnFor;
  // The no-override fast path's read (the eval scorer's BASELINE leg), memoized
  // on the same terms.
  fullFor: (text: string, vector: number[], k: number) => Promise<RetrievedChunk[]>;
  // The foreign lane's QUERY VECTOR under an override model. Memoized because
  // embedQueryCached is not free even on a hit: it books the avoided embed on
  // the savings ledger, which is a WRITE, once per question per model. A batch
  // that prefetched these already metered exactly those texts under exactly that
  // model (embedQueriesCached), so paying again per question would double-count
  // the saving as well as the round trip.
  queryVectorFor: (text: string, model: string) => Promise<number[]>;
  // Filled by prefetchRetrieval; the accessors above read it. Exposed on the
  // type because prefetchRetrieval is a free function, not a method.
  readonly memo: PrefetchMemo;
  // simsFor's memo is a private Map of PROMISES, so a prefetched answer is
  // planted through here rather than by writing to `memo` — same key, already
  // resolved, so the next simsFor call is a memo hit and never a read.
  seedSims: (model: string, text: string, sims: Map<string, number>) => void;
};

// The prefetched answers, keyed by what the accessor was asked for. A miss is
// not an error — it means this question was not in the prefetched batch (or
// nothing prefetched at all), and the accessor falls through to the store.
export type PrefetchMemo = {
  ann: Map<string, RetrievedChunk[]>;
  full: Map<string, RetrievedChunk[]>;
  pool: Map<string, Map<string, PoolDocSim>>;
  qv: Map<string, number[]>;
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
  const memo: PrefetchMemo = {
    ann: new Map(),
    full: new Map(),
    pool: new Map(),
    qv: new Map(),
  };
  return {
    overrides,
    memo,
    simsFor: (model, qv, text) => {
      const key = `${model}\0${text}`;
      let p = simCache.get(key);
      if (!p) {
        p = overrideSims(model, qv);
        simCache.set(key, p);
      }
      return p;
    },
    // Prefetched or not, the ANSWER is the same rows; only the number of round
    // trips differs. Keyed on the text alone because a context is built under
    // one override state and one config, which is what `deepN`/`excludeIds`
    // derive from — the same reasoning simsFor's key rests on.
    annFor: (text, vector, deepN, excludeIds) => {
      const hit = memo.ann.get(text);
      if (hit) return Promise.resolve(hit);
      return queryExcludingIds(vector, deepN, excludeIds);
    },
    fullFor: (text, vector, k) => {
      const hit = memo.full.get(text);
      if (hit) return Promise.resolve(hit);
      return query(vector, k);
    },
    queryVectorFor: (text, model) => {
      const hit = memo.qv.get(`${model}\0${text}`);
      if (hit) return Promise.resolve(hit);
      return embedQueryCached(text, model);
    },
    seedSims: (model, text, sims) => {
      simCache.set(`${model}\0${text}`, Promise.resolve(sims));
    },
    poolSimsFor: (ids, model, qv, text) => {
      const hit = memo.pool.get(`${model}\0${text}`);
      // The prefetched map covers the union of the batch's pools, so a caller's
      // own ids are a subset of it — narrowing is the caller's job (it reads by
      // id), exactly as it was with a per-question read.
      if (hit) return Promise.resolve(hit);
      return poolDocSims(ids, model, qv);
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

// PREFETCH A WHOLE BATCH OF QUESTIONS INTO ONE CONTEXT.
//
// THE PROBLEM IT SOLVES is round trips, not arithmetic. Every store call inside a
// request scope runs on the one connection that scope's transaction pins
// (lib/db.ts), so the eval scorer's four workers do not overlap their reads —
// they queue. Measured on the fusion path before this existed
// (scripts/fusion-timing.ts, 60 questions, 4 override models, 3 of them foreign):
//
//   per question   1 base ANN + 3 query-vector reads + 4 overrideSims
//                  + 3 poolDocSims + 1 baseline ANN  ~= 12 statements
//   wall           221.6 s, of which ~7 ms per statement was server time
//
// Roughly 780 sequential round trips to compute ~9 s of work. This collapses
// them to a handful of batched statements — one per model per leg — leaving the
// per-question path to read them out of a memo.
//
// IT CHANGES NO ANSWER. Every batched read returns the same rows as the
// per-question read it replaces (see the batch functions' own headers), and a
// question that is NOT in the memo still falls through to the store call. So
// this is not a FUSION_VERSION concern: nothing about the candidate set, the
// merge, or the arithmetic moves. scripts/fusion-equiv.ts and
// scripts/fusion-replay.ts are the two checks that hold it to that.
//
// BEST EFFORT, ALWAYS. A prefetch is an optimisation; if one of these statements
// fails, the ordinary path is still correct and still there. So a failure warns
// and leaves the memo empty rather than failing a re-score that would otherwise
// have worked.
//
// SPEND IS UNCHANGED. The only leg that can cost money is the override models'
// query vectors, and it is the same texts under the same models the per-question
// path would have embedded — through embedQueriesCached, which meters hits and
// misses exactly as embedQueryCached does, once for the batch instead of per
// question.
export async function prefetchRetrieval(
  ctx: RetrievalContext,
  questions: { text: string; vector: number[] }[],
  depth: number,
  // The baseline leg (0057) reads the no-override path for the same questions;
  // pass its k to prefetch that too. Omitted = no baseline prefetch.
  baselineK?: number,
): Promise<void> {
  if (questions.length === 0) return;
  const cfg = activeConfig();
  const texts = questions.map((q) => q.text);
  const vectors = questions.map((q) => q.vector);

  try {
    if (ctx.overrides.length > 0) {
      const overriddenIds = ctx.overrides.map((o) => o.sourceChunkId);
      const models = [...new Set(ctx.overrides.map((o) => o.model))];
      const paidN = effectiveFusionPool(depth);
      const deepN = Math.max(paidN * FUSION_DEEP_FACTOR, FUSION_DEEP_FLOOR);

      const lists = await queryExcludingIdsBatch(vectors, deepN, overriddenIds);
      texts.forEach((t, i) => ctx.memo.ann.set(t, lists[i]));

      for (const model of models) {
        const isBaseSpace = sameVectorSpace(model, cfg.embeddingModel);
        // One read for the batch's query vectors under this model — and it warms
        // the same L1 the per-question embedQueryCached reads, so the fusion
        // lane finds them in memory rather than asking again.
        const qVecs = isBaseSpace
          ? new Map(texts.map((t, i) => [t, vectors[i]]))
          : await embedQueriesCached(texts, model);
        const ordered = texts.map((t, i) => qVecs.get(t) ?? vectors[i]);
        if (!isBaseSpace) {
          texts.forEach((t, i) => ctx.memo.qv.set(`${model}\0${t}`, ordered[i]));
        }

        // simsFor memoizes on first call, so the batched answer is planted in
        // that memo directly — letting the per-question call reach the database
        // is exactly what this is here to stop.
        const sims = await overrideSimsBatch(model, ordered);
        texts.forEach((t, i) => ctx.seedSims(model, t, sims[i]));

        if (!isBaseSpace) {
          // The union of the batch's pools — every id any of these ANN lists
          // produced. Each question still reads back only its own.
          const union = [...new Set(lists.flatMap((l) => l.map((rc) => rc.chunk.chunk.id)))];
          const pools = await poolDocSimsBatch(union, model, ordered);
          texts.forEach((t, i) => ctx.memo.pool.set(`${model}\0${t}`, pools[i]));
        }
      }
    }

    if (baselineK !== undefined) {
      const base = await queryBatch(vectors, baselineK);
      texts.forEach((t, i) => ctx.memo.full.set(t, base[i]));
    }
  } catch (err) {
    console.warn(`[rag:retriever] batch prefetch failed, falling back to per-question reads: ${(err as Error).message}`);
  }
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

// The FOREIGN lane's competition: this query's base candidates, scored in the
// override model's space (docs/demo-egress-plan.md §1.2).
//
// This used to download a vector per candidate — the paid pool through
// embedDocsCached, the free deeper tier through cachedDocVectors — and cosine
// them in JS, ~12 kB of float per candidate for one number. Postgres does the
// cosine now (vectorStore.poolDocSims) and returns the number.
//
// WHAT MUST NOT CHANGE, and does not: the multiset of sims. `competitorSims` is
// only ever sorted for a cutoff and counted for a fractional rank, so order is
// free, but membership is not — it decides merged ranks, and a change there is a
// FUSION_VERSION bump (§4 D2). So the two tiers keep their existing rules:
//
//   inside paidN   every candidate contributes. A cache miss is BOUGHT, exactly
//                  as embedDocsCached bought it, after resolving its text by id.
//   below paidN    only already-banked candidates contribute; a miss is dropped,
//                  exactly as cachedDocVectors returning no entry dropped it.
//
// Precedence stays disk → the join → pay. The join is the database, so the disk
// layer has to be offered the misses explicitly, by hash — that is why poolDocSims
// puts `text_hash` on the wire at all.
async function foreignCompetitorSims(
  ids: string[],
  paidN: number,
  model: string,
  qv: number[],
  // The pool read, so a batch-prefetched context can answer it from memo. The
  // default is the store call this used to make unconditionally.
  poolSimsFor: PoolSimsFor,
  text: string,
): Promise<number[]> {
  const sims = await poolSimsFor(ids, model, qv, text);

  // Split the database's misses at the paid boundary before doing anything about
  // them, so each tier's fallback is asked for its own rows and only those.
  const buyIds: string[] = [];
  const diskHashes: string[] = [];
  ids.forEach((id, i) => {
    const row = sims.get(id);
    if (row === undefined || row.msim !== null) return;
    if (i < paidN) buyIds.push(id);
    else diskHashes.push(row.textHash);
  });

  const fromDisk = await diskDocVectorsByHash(model, diskHashes);
  const bought = new Map<string, number[]>();
  if (buyIds.length > 0) {
    // The text comes back only for what has to be embedded — the whole point of
    // the change is that the other ~95% of the pool never ships its text.
    const texts = await resolveChunks(buyIds);
    const wanted = buyIds.filter((id) => texts.has(id));
    const vecs = await embedDocsCached(
      wanted.map((id) => texts.get(id)!.text),
      model,
    );
    wanted.forEach((id, i) => bought.set(id, vecs[i]));
  }

  // A join hit inside the paid pool is an avoided embed and has to stay on the
  // savings ledger, where embedDocsCached used to book it. Priced from the
  // character count rather than the text, and de-duplicated by hash because
  // embedDocsCached metered UNIQUE texts.
  const hitChars: number[] = [];
  const metered = new Set<string>();
  const out: number[] = [];

  for (let i = 0; i < ids.length; i++) {
    const row = sims.get(ids[i]);
    if (row === undefined) continue;
    const paid = i < paidN;
    if (row.msim !== null) {
      out.push(row.msim);
      if (paid && !metered.has(row.textHash)) {
        metered.add(row.textHash);
        hitChars.push(row.textLen);
      }
      continue;
    }
    const vec = paid ? bought.get(ids[i]) : fromDisk.get(row.textHash);
    if (vec) out.push(cosine(qv, vec));
  }

  await meterEmbedHitsByChars(model, hitChars);
  return out;
}

// Rank-interleave fusion against an explicit override state. Returns the FULL
// merged list plus a `meta` map that is now ALWAYS EMPTY — no lane reads the
// pool's text any more (§1.3), so callers slice the merged list and resolve the
// ids they keep. Kept in the signature because retrieveForQuery fills it from
// resolveChunks and reads it back. Live retrieval passes the stored overrides,
// the trial dry-run a hypothetical set.
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
  // The two reads a batch can prefetch. Live retrieval passes the context's
  // memoized accessors; a trial dry-run passes nothing and every read is a store
  // call, exactly as before.
  lanes?: {
    poolSimsFor?: PoolSimsFor;
    annFor?: AnnFor;
    queryVectorFor?: (text: string, model: string) => Promise<number[]>;
  },
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
  // NOTHING in this merge reads the pool's text any more (docs/demo-egress-plan.md
  // §1.3). The foreign lane used to re-embed the paid pool and look the deeper
  // candidates up in cachedDocVectors BY TEXT, which forced text onto all deepN
  // rows; phase 2 moved that lookup into Postgres (poolDocSims joins on a hash the
  // database computes), so every lane now wants (id, score) alone and the light
  // ANN is the only read.
  //
  // Keyed on everything the ANN result depends on: the query, the excluded set
  // (sorted so ordering can't produce a false miss), and the depth. The T/L
  // discriminator that used to be here is gone with the second read it chose
  // between.
  const annKey = annCache
    ? `${text}\0${deepN}\0${[...overriddenIds].sort().join(",")}`
    : null;
  const cachedAnn = annKey !== null ? annCache!.get(annKey) : undefined;
  const baseChunks =
    cachedAnn ??
    (await (lanes?.annFor
      ? lanes.annFor(text, baseVector, deepN, overriddenIds)
      : queryExcludingIds(baseVector, deepN, overriddenIds)));
  if (annKey !== null && cachedAnn === undefined) annCache!.set(annKey, baseChunks);
  // `meta` therefore starts EMPTY, always: retrieveForQuery's resolveChunks
  // fallback fills the topK that survive — the same path override winners have
  // always taken.
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
    const qv = isBaseSpace
      ? baseVector
      : await (lanes?.queryVectorFor
          ? lanes.queryVectorFor(text, model)
          : embedQueryCached(text, model));
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
      competitorSims = await foreignCompetitorSims(
        baseChunks.map((rc) => rc.chunk.chunk.id),
        paidN,
        model,
        qv,
        lanes?.poolSimsFor ?? ((ids, m, v) => poolDocSims(ids, m, v)),
        text,
      );
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
    const retrieved = ctx ? await ctx.fullFor(text, baseVector, k) : await query(baseVector, k);
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
    undefined,
    undefined,
    ctx
      ? {
          poolSimsFor: ctx.poolSimsFor,
          annFor: ctx.annFor,
          queryVectorFor: ctx.queryVectorFor,
        }
      : undefined,
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
