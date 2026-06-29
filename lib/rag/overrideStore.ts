// ---------------------------------------------------------------------------
// DB layer for per-chunk embedding-model overrides (migration 0013, Phase 5).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config like the
// other stores. An override is an alternate vector for a chunk that still lives
// in the config's base chunks_<model>_<dim> table — see retriever.ts for how the
// base ANN and the override sets are fused by RRF at query time.
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";

export type ChunkOverride = { sourceChunkId: string; model: string };
export type OverrideEmbedding = { chunkId: string; embedding: number[] };

// Persist (or replace) the override for one chunk under the active config. The
// embedding is the chunk's text re-embedded under `model` (caller computes it).
export async function setChunkOverride(
  sourceChunkId: string,
  model: string,
  dimension: number,
  embedding: number[],
): Promise<void> {
  const cfg = activeConfig();
  await sql`
    insert into config_chunk_overrides
      (config_id, source_chunk_id, model, dimension, embedding)
    values
      (${cfg.id}, ${sourceChunkId}, ${model}, ${dimension}, ${embedding}::real[])
    on conflict (config_id, source_chunk_id)
      do update set model = excluded.model,
                    dimension = excluded.dimension,
                    embedding = excluded.embedding,
                    created_at = now()
  `;
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
    const rows = await sql<{ source_chunk_id: string; model: string }[]>`
      select source_chunk_id, model
      from config_chunk_overrides
      where config_id = ${cfg.id}
    `;
    return rows.map((r) => ({ sourceChunkId: r.source_chunk_id, model: r.model }));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

// The override vectors for one model under the active config — the candidate set
// RRF ranks against the query embedded under that same model.
export async function overrideEmbeddings(model: string): Promise<OverrideEmbedding[]> {
  const cfg = activeConfig();
  const rows = await sql<{ source_chunk_id: string; embedding: number[] }[]>`
    select source_chunk_id, embedding
    from config_chunk_overrides
    where config_id = ${cfg.id} and model = ${model}
  `;
  return rows.map((r) => ({ chunkId: r.source_chunk_id, embedding: r.embedding }));
}
