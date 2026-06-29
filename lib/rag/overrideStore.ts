// ---------------------------------------------------------------------------
// DB layer for per-chunk embedding-model overrides (migration 0013, Phase 5).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config like the
// other stores. An override is an alternate vector for a chunk that still lives
// in the config's base chunks_<model>_<dim> table — see retriever.ts for how the
// base ANN and the override sets are fused by RRF at query time.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";

export type OverrideKind = "model" | "size" | "size+model";
export type ChunkOverride = { sourceChunkId: string; model: string; kind: OverrideKind };
export type OverrideEmbedding = { chunkId: string; embedding: number[] };

// One piece of a chunk override (migration 0015). For a model-only override
// there's a single piece (text null => the whole base chunk); a size / size+model
// override stores N re-split pieces, each with its own text + vector and optional
// token span within the source chunk (Phase D gap detection).
export type OverridePiece = {
  text: string | null;
  dimension: number;
  embedding: number[];
  tokenStart?: number | null;
  tokenEnd?: number | null;
};

// Persist (or replace) a chunk's override as a set of PIECES under the active
// config, atomically — clears any existing override for the chunk first (any
// kind), then inserts the new pieces at piece_index 0..n-1.
export async function setChunkOverridePieces(
  sourceChunkId: string,
  model: string,
  kind: OverrideKind,
  pieces: OverridePiece[],
): Promise<void> {
  const cfg = activeConfig();
  await sql.begin(async (tx) => {
    await tx`
      delete from config_chunk_overrides
      where config_id = ${cfg.id} and source_chunk_id = ${sourceChunkId}
    `;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      await tx`
        insert into config_chunk_overrides
          (config_id, source_chunk_id, piece_index, model, dimension, kind,
           text, token_start, token_end, embedding)
        values
          (${cfg.id}, ${sourceChunkId}, ${i}, ${model}, ${p.dimension}, ${kind},
           ${p.text ?? null}, ${p.tokenStart ?? null}, ${p.tokenEnd ?? null},
           ${p.embedding}::real[])
      `;
    }
  });
}

// Model-only override: one whole-chunk piece under `model` (the chunk's text
// re-embedded under it — caller computes the vector). Thin wrapper kept for the
// "try a different model → Set as override" path.
export async function setChunkOverride(
  sourceChunkId: string,
  model: string,
  dimension: number,
  embedding: number[],
): Promise<void> {
  await setChunkOverridePieces(sourceChunkId, model, "model", [
    { text: null, dimension, embedding },
  ]);
}

// Remove a chunk's override under the active config. Returns false when none.
export async function clearChunkOverride(sourceChunkId: string): Promise<boolean> {
  const cfg = activeConfig();
  const rows = await sql`
    delete from config_chunk_overrides
    where config_id = ${cfg.id} and source_chunk_id = ${sourceChunkId}
    returning source_chunk_id
  `;
  return rows.length > 0;
}

// Every override for the active config (chunk id + which model), for retrieval
// fan-out and UI badges. Called on every retrieval, so it tolerates the table
// not existing yet (migration 0013 unapplied): Postgres "undefined_table"
// (42P01) → no overrides, i.e. the app behaves exactly as pre-Phase-5 until 0013
// lands. Any other error propagates.
export async function listOverrides(): Promise<ChunkOverride[]> {
  const cfg = activeConfig();
  try {
    // DISTINCT: a chunk now has several piece rows, but one model + kind.
    const rows = await sql<{ source_chunk_id: string; model: string; kind: string }[]>`
      select distinct source_chunk_id, model, kind
      from config_chunk_overrides
      where config_id = ${cfg.id}
    `;
    return rows.map((r) => ({
      sourceChunkId: r.source_chunk_id,
      model: r.model,
      kind: r.kind as OverrideKind,
    }));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

// Every override PIECE under one model for the active config — the candidate set
// RRF ranks against the query embedded under that model. Returns one row per
// piece (chunkId = the source chunk it belongs to); the retriever collapses to
// the best piece per source chunk (hit = any piece in top-k).
export async function overrideEmbeddings(model: string): Promise<OverrideEmbedding[]> {
  const cfg = activeConfig();
  const rows = await sql<{ source_chunk_id: string; embedding: number[] }[]>`
    select source_chunk_id, embedding
    from config_chunk_overrides
    where config_id = ${cfg.id} and model = ${model}
  `;
  return rows.map((r) => ({ chunkId: r.source_chunk_id, embedding: r.embedding }));
}
