// ---------------------------------------------------------------------------
// QUERY TIME, STEP 1: RETRIEVE
//
// Given the user's question, find the most relevant chunks in the active config.
//
// Fast path (no per-chunk overrides): a single config-filtered ANN on the base
// model — unchanged from before.
//
// When the config has per-chunk model OVERRIDES (Phase 5), retrieval fuses
// multiple embedding spaces by Reciprocal Rank Fusion (D7): the base-model ANN
// over the NON-overridden chunks, plus — for each override model — that model's
// overridden chunks ranked by cosine against the query embedded under that same
// model. Raw cosine isn't comparable across embedding spaces, so we combine by
// RANK, not score. Each chunk lives in exactly one space (its canonical model),
// so the spaces interleave by rank position.
// ---------------------------------------------------------------------------
import { activeConfig } from "@/lib/rag/activeConfig";
import { cosine } from "@/lib/rag/embedCache";
import { embedQuery } from "@/lib/rag/embeddings";
import { listOverrides, overrideEmbeddings } from "@/lib/rag/overrideStore";
import { query, queryExcluding, resolveChunks } from "@/lib/rag/vectorStore";
import type { RetrievedChunk } from "@/types/rag";

// Standard RRF constant; tunable (see plan §9 — RRF tuning).
const RRF_K = 60;
// Base candidates pulled for fusion when overrides exist (vs the final top-k).
const FUSION_BASE_FACTOR = 4;

export async function retrieve(question: string): Promise<RetrievedChunk[]> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Cannot retrieve for an empty question.");
  const vector = await embedQuery(trimmed);
  return retrieveForQuery(trimmed, vector);
}

// Retrieve the active config's top-k for a query. `baseVector` is the query
// already embedded under the base model (eval reuses a cached one); override-
// model query vectors are embedded on demand from `text`.
export async function retrieveForQuery(
  text: string,
  baseVector: number[],
): Promise<RetrievedChunk[]> {
  const cfg = activeConfig();
  const overrides = await listOverrides();
  // No overrides → the original single-space ANN. Identical behaviour + cost.
  if (overrides.length === 0) return query(baseVector, cfg.topK);

  const overriddenIds = overrides.map((o) => o.sourceChunkId);
  const models = [...new Set(overrides.map((o) => o.model))];

  const lists: { id: string; rank: number }[][] = [];
  const meta = new Map<string, { documentId: string; position: number; text: string }>();

  // Base space: ANN over the non-overridden chunks; pull a generous N for fusion.
  const baseN = Math.max(cfg.topK * FUSION_BASE_FACTOR, 50);
  const baseChunks = await queryExcluding(baseVector, baseN, overriddenIds);
  baseChunks.forEach((rc) =>
    meta.set(rc.chunk.chunk.id, {
      documentId: rc.chunk.chunk.documentId,
      position: rc.chunk.chunk.position,
      text: rc.chunk.chunk.text,
    }),
  );
  lists.push(baseChunks.map((rc, i) => ({ id: rc.chunk.chunk.id, rank: i + 1 })));

  // Override spaces: rank each override model's chunks against the query embedded
  // under that model (a small full-scan — only a few overrides per model).
  for (const model of models) {
    const qv = await embedQuery(text, model);
    const embs = await overrideEmbeddings(model);
    const scored = embs
      .map((e) => ({ id: e.chunkId, sim: cosine(qv, e.embedding) }))
      .sort((a, b) => b.sim - a.sim);
    lists.push(scored.map((s, i) => ({ id: s.id, rank: i + 1 })));
  }

  // Reciprocal Rank Fusion.
  const rrf = new Map<string, number>();
  for (const list of lists) {
    for (const { id, rank } of list) {
      rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  const top = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, cfg.topK);

  // Override winners weren't in the base ANN (they were excluded) — resolve them.
  const unresolved = top.map(([id]) => id).filter((id) => !meta.has(id));
  for (const [id, m] of await resolveChunks(unresolved)) meta.set(id, m);

  return top.map(([id, score]) => {
    const m = meta.get(id);
    return {
      score,
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
