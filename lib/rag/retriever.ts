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
// override model (cached persistently — see embedCache/0020 — so steady-state
// cost is one query embedding per override model). The candidates themselves
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
import { cosine, embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
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
const FUSION_BASE_FACTOR = 4;

// One entry of the merged fusion list. `sim` is the chunk's real cosine to the
// query in its CANONICAL space (base model for base chunks, the override model
// for overridden chunks) — informational: honest per-chunk, but not comparable
// across spaces and therefore not monotone with the merged order.
export type FusedCandidate = { id: string; rank: number; sim: number };

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
): Promise<{
  merged: FusedCandidate[];
  meta: Map<string, { documentId: string; position: number; text: string }>;
}> {
  const cfg = activeConfig();
  const overriddenIds = overrides.map((o) => o.sourceChunkId);
  const models = [...new Set(overrides.map((o) => o.model))];

  const lists: FusedCandidate[][] = [];
  const meta = new Map<string, { documentId: string; position: number; text: string }>();

  // Base space: ANN over the non-overridden chunks; pull a generous N for fusion.
  const baseN = Math.max(k * FUSION_BASE_FACTOR, 50);
  const baseChunks = await queryExcluding(baseVector, baseN, overriddenIds);
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
    // Base space → their cosine sims are the ANN scores we already have;
    // otherwise re-embed their texts under the model (persistent cache).
    let competitorSims: number[];
    if (isBase) {
      competitorSims = baseChunks.map((rc) => rc.score);
    } else {
      const texts = baseChunks.map((rc) => rc.chunk.chunk.text);
      const vecs = await embedDocsCached(texts, model);
      competitorSims = vecs.map((v) => cosine(qv, v));
    }

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
  return { merged, meta };
}

// Retrieve a query's top results in the active config. `baseVector` is the query
// already embedded under the base model (eval reuses a cached one); override-
// model query vectors are embedded on demand from `text`. `limit` defaults to the
// config's top_k; eval passes a larger superset so one retrieved list can score
// Recall@recall_k and nDCG@ndcg_k at once (A1, see lib/rag/evalSettingsStore).
export async function retrieveForQuery(
  text: string,
  baseVector: number[],
  limit?: number,
): Promise<RetrievedChunk[]> {
  const cfg = activeConfig();
  const k = limit ?? cfg.topK;
  const overrides = await listOverrides();
  // No overrides → the original single-space ANN. Identical behaviour + cost.
  if (overrides.length === 0) return query(baseVector, k);

  const { merged, meta } = await fuseWithOverrides(
    text,
    baseVector,
    k,
    overrides,
    overrideEmbeddings,
  );
  const top = merged.slice(0, k);

  // Override winners weren't in the base ANN (they were excluded) — resolve them.
  const unresolved = top.map(({ id }) => id).filter((id) => !meta.has(id));
  for (const [id, m] of await resolveChunks(unresolved)) meta.set(id, m);

  return top.map(({ id, sim }) => {
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
}
