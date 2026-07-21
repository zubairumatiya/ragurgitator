// ---------------------------------------------------------------------------
// DB layer for per-chunk embedding-model overrides (migration 0013, Phase 5).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config like the
// other stores. An override is an alternate vector for a chunk that still lives
// in the config's base chunks_<model>_<dim> table — see retriever.ts for how the
// base ANN and the override sets are rank-fused at query time.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
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

// One entry of the retrieval change log (0021) — what the stale badge lists.
export type RetrievalChange = { description: string; at: Date };

// Version of the rank-fusion ALGORITHM (retriever.fuseWithOverrides), folded
// into the fingerprint below. Bump it whenever fusion semantics change (how
// ranks are computed/merged, what `score` means) so results scored under the
// old algorithm flag stale and get re-scored — the override ROWS can't capture
// that kind of change. v2 = fractional fusion ranks + real canonical-space
// sims (July 2026); the pre-v2 fingerprint had no version prefix, so adding
// one also invalidates everything scored before versioning existed. v3 = the
// competitor set became paid-pool + free already-cached candidates from a
// deeper base list, and base-space overrides compete against the full deep
// list (July 2026). Note v3 ranks also drift (toward more accurate) as the
// cache warms — that part is uncapturable here by design.
// v4 = a model override that SHARES the base model's vectorSpace now folds into
// the base lane (ranked by real cosine against the base query, no separate
// fusion lane or re-embedding under its own model) instead of opening a lane
// (July 2026) — same-space overrides rank differently, so older results re-score.
export const FUSION_VERSION = 4;

// Fingerprint of the active config's current override state (0022): sha-256
// over the fusion version + the canonical override rows, or 'baseline' when
// there are none (the base-ANN-only path — no fusion, so no version). Each
// eval result is stamped with the fingerprint it was scored under; a result is
// stale iff its fingerprint differs from the current one — so REVERTING a
// change (e.g. delegate back to baseline) makes the old results valid again
// without a re-score. Embeddings aren't hashed: (model, kind, text/span)
// determines them (and they're cached), so the semantic rows suffice.
export async function retrievalStateFingerprint(): Promise<string> {
  const cfg = activeConfig();
  try {
    const rows = await sql<
      {
        source_chunk_id: string;
        model: string;
        kind: string;
        piece_index: number;
        token_start: number | null;
        token_end: number | null;
        text_hash: string | null;
      }[]
    >`
      select source_chunk_id, model, kind, piece_index, token_start, token_end,
             md5(text) as text_hash
      from config_chunk_overrides
      where config_id = ${cfg.id}
      order by source_chunk_id, piece_index
    `;
    if (rows.length === 0) return "baseline";
    // The live fusion pool (0027) shapes every fused rank, so it's part of the
    // state — changing it (while overrides exist) stales scored results, and
    // changing it back revalidates them. Auto (null) contributes NOTHING so
    // fingerprints from before the pool existed stay valid — auto IS the
    // historical behavior.
    const canonical =
      `fusion-v${FUSION_VERSION}\n` +
      (cfg.fusionPool === null ? "" : `pool-${cfg.fusionPool}\n`) +
      rows
        .map(
          (r) =>
            `${r.source_chunk_id}|${r.model}|${r.kind}|${r.piece_index}|` +
            `${r.token_start ?? ""}|${r.token_end ?? ""}|${r.text_hash ?? ""}`,
        )
        .join("\n");
    return createHash("sha256").update(canonical).digest("hex");
  } catch (err) {
    // Overrides table missing (0013 unapplied) -> plain baseline retrieval.
    if ((err as { code?: string }).code === "42P01") return "baseline";
    throw err;
  }
}

// "resume.pdf · chunk #3" for change-log descriptions — falls back to a short
// id when the chunk can't be resolved (matches the dashboard's `chunk #n`).
async function chunkLabel(sourceChunkId: string): Promise<string> {
  try {
    const cfg = activeConfig();
    const [row] = await sql<{ position: number | null; file_name: string }[]>`
      select c.position, d.file_name
      from ${sql(cfg.chunksTable)} c
      join documents d on d.id = c.document_id
      join document_embeddings de on de.id = c.document_embedding_id
      where c.id = ${sourceChunkId} and de.config_id = ${cfg.id}
      limit 1
    `;
    if (row) return `${row.file_name} · chunk #${row.position ?? "?"}`;
  } catch {
    // fall through to the id fallback
  }
  return `chunk ${sourceChunkId.slice(0, 8)}`;
}

// The chunk's override BEFORE a mutation, phrased for the "(was …)" suffix.
function wasLabel(prev: { model: string; kind: OverrideKind } | undefined): string {
  if (!prev) return "was baseline";
  if (prev.kind === "model") return `was ${prev.model}`;
  if (prev.kind === "size") return "was re-split";
  return `was re-split + ${prev.model}`;
}

// Append one change-log row (0021). Best-effort: tolerates the table not
// existing yet (42P01) — the badge just has no history until 0021 lands.
async function logRetrievalChange(
  sourceChunkId: string | null,
  description: string,
): Promise<void> {
  const cfg = activeConfig();
  try {
    await sql`
      insert into config_retrieval_changes (config_id, source_chunk_id, description)
      values (${cfg.id}, ${sourceChunkId}, ${description})
    `;
  } catch (err) {
    if ((err as { code?: string }).code !== "42P01") throw err;
  }
}

// The config's logged override changes, newest first — the stale badge's hover
// list. 42P01 (0021 unapplied) → empty.
export async function listRetrievalChanges(): Promise<RetrievalChange[]> {
  const cfg = activeConfig();
  try {
    const rows = await sql<{ description: string; created_at: Date }[]>`
      select description, created_at
      from config_retrieval_changes
      where config_id = ${cfg.id}
      order by created_at desc
      limit 50
    `;
    return rows.map((r) => ({ description: r.description, at: r.created_at }));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

// Record a change to the live fusion pool (0027). Only meaningful when the
// config has overrides — without them retrieval is the plain base ANN and the
// pool plays no part (and the fingerprint stays 'baseline'), so this no-ops
// rather than flagging results stale for a change with zero effect.
export async function noteFusionPoolChange(
  prev: number | null,
  next: number | null,
): Promise<void> {
  const overrides = await listOverrides();
  if (overrides.length === 0) return;
  await sql`
    update configs set retrieval_changed_at = now() where id = ${activeConfig().id}
  `;
  const label = (v: number | null) => (v === null ? "auto" : String(v));
  await logRetrievalChange(null, `fusion pool → ${label(next)} (was ${label(prev)})`);
}

// Drop the config's change log — called once a full re-score has made every
// result fresh again (the changes are baked into the rates now).
export async function clearRetrievalChanges(): Promise<void> {
  try {
    await sql`
      delete from config_retrieval_changes where config_id = ${activeConfig().id}
    `;
  } catch (err) {
    if ((err as { code?: string }).code !== "42P01") throw err;
  }
}

// Persist (or replace) a chunk's override as a set of PIECES under the active
// config, atomically — clears any existing override for the chunk first (any
// kind), then inserts the new pieces at piece_index 0..n-1. Stamps the config's
// retrieval_changed_at (0019): an override changes rank-fused retrieval for
// EVERY query, so results scored before this moment are stale. `detail` is the
// change-log phrasing (0021), e.g. "delegate → voyage-3"; callers with size /
// overlap context pass something richer than the kind-derived default.
export async function setChunkOverridePieces(
  sourceChunkId: string,
  model: string,
  kind: OverrideKind,
  pieces: OverridePiece[],
  detail?: string,
): Promise<void> {
  const cfg = activeConfig();
  const [label, prev] = await Promise.all([
    chunkLabel(sourceChunkId),
    listOverrides().then((all) => all.find((o) => o.sourceChunkId === sourceChunkId)),
  ]);
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
    await tx`
      update configs set retrieval_changed_at = now() where id = ${cfg.id}
    `;
  });
  const fallback = kind === "model" ? `delegate → ${model}` : `re-split under ${model}`;
  await logRetrievalChange(
    sourceChunkId,
    `${label}: ${detail ?? fallback} (${wasLabel(prev)})`,
  );
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
// Clearing changes retrieval just like setting does, so it also stamps
// retrieval_changed_at — but only when a row was actually deleted.
export async function clearChunkOverride(sourceChunkId: string): Promise<boolean> {
  const cfg = activeConfig();
  const rows = await sql<{ model: string; kind: OverrideKind }[]>`
    delete from config_chunk_overrides
    where config_id = ${cfg.id} and source_chunk_id = ${sourceChunkId}
    returning model, kind
  `;
  if (rows.length > 0) {
    await sql`update configs set retrieval_changed_at = now() where id = ${cfg.id}`;
    await logRetrievalChange(
      sourceChunkId,
      `${await chunkLabel(sourceChunkId)}: override cleared → baseline (${wasLabel(rows[0])})`,
    );
  }
  return rows.length > 0;
}

// When the active config's retrieval last changed shape (an override set or
// cleared), or null when it never has. Tolerates the column not existing yet
// (migration 0019 unapplied, Postgres "undefined_column" 42703) → null, i.e.
// nothing is retrieval-stale until 0019 lands — matching listOverrides' 42P01
// tolerance below.
export async function getRetrievalChangedAt(): Promise<Date | null> {
  const cfg = activeConfig();
  try {
    const [row] = await sql<{ retrieval_changed_at: Date | null }[]>`
      select retrieval_changed_at from configs where id = ${cfg.id}
    `;
    return row?.retrieval_changed_at ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === "42703") return null;
    throw err;
  }
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

// One chunk's FULL stored override under the active config — model, kind, and
// the ordered pieces with their vectors — or null when it has none. Captured
// by autotune before it persists a candidate, so a failed confirm can RESTORE
// the prior override exactly (via setChunkOverridePieces) instead of clearing
// the chunk to baseline and losing an earlier run's working override.
export async function getChunkOverridePieces(
  sourceChunkId: string,
): Promise<{ model: string; kind: OverrideKind; pieces: OverridePiece[] } | null> {
  const cfg = activeConfig();
  try {
    const rows = await sql<
      {
        model: string;
        kind: string;
        text: string | null;
        dimension: number;
        embedding: number[];
        token_start: number | null;
        token_end: number | null;
      }[]
    >`
      select model, kind, text, dimension, embedding, token_start, token_end
      from config_chunk_overrides
      where config_id = ${cfg.id} and source_chunk_id = ${sourceChunkId}
      order by piece_index
    `;
    if (rows.length === 0) return null;
    return {
      model: rows[0].model,
      kind: rows[0].kind as OverrideKind,
      pieces: rows.map((r) => ({
        text: r.text,
        dimension: r.dimension,
        embedding: r.embedding,
        tokenStart: r.token_start,
        tokenEnd: r.token_end,
      })),
    };
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

// Every override PIECE under one model for the active config — the candidate set
// the retriever ranks against the query embedded under that model. Returns one row per
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
