// DB layer for per-chunk embedding-model overrides (migration 0013, Phase 5).
// Raw SQL via the shared `sql` client; scoped to the ACTIVE config like the
// other stores. An override is an alternate vector for a chunk that still lives
// in the config's base chunks_<model>_<dim> table — see retriever.ts for how the
// base ANN and the override sets are rank-fused at query time.
import { scopeForget, scopeMemo, sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";

export type OverrideKind = "model" | "size" | "size+model";
export type ChunkOverride = {
  sourceChunkId: string;
  model: string;
  kind: OverrideKind;
};
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

// Version of the rank-fusion ALGORITHM (retriever.fuseWithOverrides), folded into
// the fingerprint below. Bump it whenever fusion semantics change (how ranks are
// computed/merged, what `score` means) so results scored under the old algorithm
// flag stale and get re-scored — the override ROWS can't capture that kind of
// change.
//   v2  fractional fusion ranks + real canonical-space sims. The pre-v2 fingerprint
//       had no version prefix, so adding one also invalidated everything scored
//       before versioning existed.
//   v3  the competitor set became paid-pool + free already-cached candidates from a
//       deeper base list, and base-space overrides compete against the full deep
//       list. Note v3 ranks also drift (toward more accurate) as the cache warms —
//       uncapturable here by design.
//   v4  a model override SHARING the base model's vectorSpace now folds into the
//       base lane instead of opening a fusion lane, so same-space overrides rank
//       differently and older results re-score.
export const FUSION_VERSION = 4;

// Fingerprint of the active config's current override state (0022): sha-256
// over the fusion version + the canonical override rows, or 'baseline' when
// there are none (the base-ANN-only path — no fusion, so no version). Each
// eval result is stamped with the fingerprint it was scored under; a result is
// stale iff its fingerprint differs from the current one — so REVERTING a
// change (e.g. delegate back to baseline) makes the old results valid again
// without a re-score. Embeddings aren't hashed: (model, kind, text/span)
// determines them (and they're cached), so the semantic rows suffice.
//
// Once per scope (scopeMemo): every writer of config_chunk_overrides or
// retrieval_changed_at below calls forgetRetrievalState(), and so does
// vectorStore.deleteEmbeddingRunFor. A ⚙ press read this 95 times.
export async function retrievalStateFingerprint(): Promise<string> {
  const cfg = activeConfig();
  return scopeMemo(`fingerprint:${cfg.id}`, () => computeFingerprint(cfg));
}

export function forgetRetrievalState(): void {
  scopeForget("fingerprint:");
  scopeForget("changedAt:");
  scopeForget("portableKey:");
}

// THE PORTABLE RETRIEVAL KEY — docs/demo-retrieval-bank-plan.md §3.1.
//
// The fingerprint above names an override state IN THIS WORKSPACE: its rows
// carry `source_chunk_id`, and chunk ids are minted fresh per clone
// (lib/demo/clone.ts `_map_chunk`), so the same override set digests
// differently in every guest and can never key a bank shared across them. This
// is the SAME canonical string — same prefix, same fields, same separators —
// with each row's chunk id replaced by the md5 of the chunk's TEXT, which the
// clone copies byte for byte. Two workspaces holding the same override set over
// the same corpus produce the same key; scripts/portable-key-equiv.ts asserts
// that on live and test/integration/demoRetrievalBank.itest.ts asserts it across
// a real clone.
//
// NOT A REPLACEMENT FOR THE FINGERPRINT. eval_results.retrieval_state keeps
// stamping the real one — staleness is a question about this workspace. The
// portable key is only ever a lookup key into the demo's retrieval bank
// (lib/demo/replay.readRetrievalBank), and is read for a real account too,
// where it costs one memoed statement per scope and keys nothing.
//
// ORDER IS THE WHOLE KEY. The fingerprint orders by (source_chunk_id,
// piece_index); this orders by (text md5, piece_index) and then by the rest of
// the row, so two chunks that happen to share text cannot make the string
// depend on which row the planner emitted first. 'baseline' with no rows, as
// the fingerprint is, and for the same reason: a no-override retrieval is one
// state everywhere, and the demo's baseline leg is keyed by exactly this word.
//
// Once per scope under the fingerprint's forget: every writer that invalidates
// the fingerprint invalidates this, so a press with 19 installs pays for it
// once per install rather than once per read.
export async function portableRetrievalKey(): Promise<string> {
  const cfg = activeConfig();
  return scopeMemo(`portableKey:${cfg.id}`, () => computePortableKey(cfg));
}

async function computePortableKey(
  cfg: ReturnType<typeof activeConfig>,
): Promise<string> {
  const prefix =
    `fusion-v${FUSION_VERSION}\n` +
    (cfg.fusionPool === null ? "" : `pool-${cfg.fusionPool}\n`);
  try {
    const [row] = await sql<{ digest: string | null }[]>`
      select encode(
               sha256(convert_to(
                 ${prefix} || string_agg(
                   md5(c.text) || '|' || o.model || '|' || o.kind || '|'
                     || o.piece_index::text || '|' || coalesce(o.token_start::text, '') || '|'
                     || coalesce(o.token_end::text, '') || '|' || coalesce(md5(o.text), ''),
                   E'\n' order by md5(c.text), o.piece_index, o.model, o.kind,
                                  coalesce(o.token_start::text, ''), coalesce(o.token_end::text, ''),
                                  coalesce(md5(o.text), '')
                 ),
                 'utf8'
               )),
               'hex'
             ) as digest
      from config_chunk_overrides o
      join ${sql(cfg.chunksTable)} c on c.id = o.source_chunk_id
      where o.config_id = ${cfg.id}
    `;
    return row?.digest ?? "baseline";
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return "baseline";
    throw err;
  }
}

async function computeFingerprint(
  cfg: ReturnType<typeof activeConfig>,
): Promise<string> {
  // The canonical string's PREFIX is app state, not row state: the fusion
  // version is a constant here and the live fusion pool (0027) shapes every
  // fused rank, so it's part of the state — changing it (while overrides exist)
  // stales scored results, and changing it back revalidates them. Auto (null)
  // contributes NOTHING so fingerprints from before the pool existed stay valid
  // — auto IS the historical behavior.
  const prefix =
    `fusion-v${FUSION_VERSION}\n` +
    (cfg.fusionPool === null ? "" : `pool-${cfg.fusionPool}\n`);
  try {
    // Postgres builds the canonical string and hashes it, so the app reads 64
    // hex characters instead of every override piece row — the digest used to
    // cost a full download of the pieces table 8,668 times over
    // (docs/demo-egress-plan.md §1.5). Byte-for-byte the same string the JS
    // form built: `|` between fields, E'\n' between rows, md5 for the text,
    // coalesce for the nullable columns, ordered by the same two columns in
    // their own types. `scripts/fingerprint-equiv.ts` holds the JS reference
    // and asserts the two agree — run it before touching anything here, since a
    // one-byte drift stales every scored result in the database.
    const [row] = await sql<{ digest: string | null }[]>`
      select encode(
               sha256(convert_to(
                 ${prefix} || string_agg(
                   source_chunk_id::text || '|' || model || '|' || kind || '|'
                     || piece_index::text || '|' || coalesce(token_start::text, '') || '|'
                     || coalesce(token_end::text, '') || '|' || coalesce(md5(text), ''),
                   E'\n' order by source_chunk_id, piece_index
                 ),
                 'utf8'
               )),
               'hex'
             ) as digest
      from config_chunk_overrides
      where config_id = ${cfg.id}
    `;
    // No pieces => string_agg is null => the digest is null: the baseline
    // (base-ANN-only) path, no fusion and so no version.
    return row?.digest ?? "baseline";
  } catch (err) {
    // Overrides table missing (0013 unapplied) -> plain baseline retrieval.
    if ((err as { code?: string }).code === "42P01") return "baseline";
    throw err;
  }
}

// "resume.pdf · chunk #3" for change-log descriptions — falls back to a short
// id when the chunk can't be resolved (matches the dashboard's `chunk #n`).
// Once per scope per chunk (cut 3): a file name and a position do not move
// under a running scope, and the confirm asks for this label on every install
// and every revert of the same chunk.
function chunkLabel(sourceChunkId: string): Promise<string> {
  return scopeMemo(`chunkLabel:${sourceChunkId}`, () =>
    readChunkLabel(sourceChunkId),
  );
}

async function readChunkLabel(sourceChunkId: string): Promise<string> {
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
function wasLabel(
  prev: { model: string; kind: OverrideKind } | undefined,
): string {
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
  forgetRetrievalState();
  const label = (v: number | null) => (v === null ? "auto" : String(v));
  await logRetrievalChange(
    null,
    `fusion pool → ${label(next)} (was ${label(prev)})`,
  );
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
    listOverrides().then((all) =>
      all.find((o) => o.sourceChunkId === sourceChunkId),
    ),
  ]);
  await sql.begin(async (tx) => {
    await tx`
      delete from config_chunk_overrides
      where config_id = ${cfg.id} and source_chunk_id = ${sourceChunkId}
    `;
    // L18: ONE multi-row insert, not one round trip per piece. The pieces are
    // independent rows and a transaction runs sequentially on a single
    // connection, so the old loop paid the full network latency per piece —
    // ~130ms each against this database, on top of BEGIN/DELETE/UPDATE/COMMIT.
    // Autotune persists a candidate on every confirm, which made this the
    // `persist` bucket's 41.6s.
    // Composed as fragments rather than postgres.js's values helper: the helper
    // rejects nulls (text/token_start are nullable) and would drop the explicit
    // ::real[] cast the embedding column needs.
    if (pieces.length > 0) {
      const rows = pieces.map(
        (p, i) => tx`(
          ${cfg.id}, ${sourceChunkId}, ${i}, ${model}, ${p.dimension}, ${kind},
          ${p.text ?? null}, ${p.tokenStart ?? null}, ${p.tokenEnd ?? null},
          ${p.embedding}::real[]
        )`,
      );
      const allRows = rows.reduce((acc, row) => tx`${acc}, ${row}`);
      await tx`
        insert into config_chunk_overrides
          (config_id, source_chunk_id, piece_index, model, dimension, kind,
           text, token_start, token_end, embedding)
        values ${allRows}
      `;
    }
    await tx`
      update configs set retrieval_changed_at = now() where id = ${cfg.id}
    `;
  });
  forgetRetrievalState();
  const fallback =
    kind === "model" ? `delegate → ${model}` : `re-split under ${model}`;
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
export async function clearChunkOverride(
  sourceChunkId: string,
): Promise<boolean> {
  const cfg = activeConfig();
  const rows = await sql<{ model: string; kind: OverrideKind }[]>`
    delete from config_chunk_overrides
    where config_id = ${cfg.id} and source_chunk_id = ${sourceChunkId}
    returning model, kind
  `;
  if (rows.length > 0) {
    await sql`update configs set retrieval_changed_at = now() where id = ${cfg.id}`;
    forgetRetrievalState();
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
  return scopeMemo(`changedAt:${cfg.id}`, async () => {
    try {
      const [row] = await sql<{ retrieval_changed_at: Date | null }[]>`
        select retrieval_changed_at from configs where id = ${cfg.id}
      `;
      return row?.retrieval_changed_at ?? null;
    } catch (err) {
      if ((err as { code?: string }).code === "42703") return null;
      throw err;
    }
  });
}

// PER-CHUNK override fingerprints — retrievalStateFingerprint's question asked
// one chunk at a time: has THIS chunk's override changed?
//
// An autotune run needs the answer to decide which chunks its dirty-set re-score
// must account for. It used to answer it by remembering, in memory, which chunks
// it had applied an override to — which cannot survive a run that stops and
// resumes, and which silently misses a chunk whose override was already persisted
// by a slice that then crashed before its cursor moved. Comparing a snapshot of
// these against the live ones answers it from the data instead, and catches the
// case an id-only comparison misses: a chunk that HAD an override and got a
// different one is changed, even though its id is in both sets.
//
// Hashes the same fields the global fingerprint canonicalizes (model, kind, piece
// order, span, text), so two overrides that retrieve identically fingerprint
// identically. Same 42P01 tolerance as listOverrides below.
export async function overrideFingerprints(): Promise<Map<string, string>> {
  const cfg = activeConfig();
  try {
    const rows = await sql<{ source_chunk_id: string; fingerprint: string }[]>`
      select source_chunk_id,
             md5(string_agg(
               model || '|' || kind || '|' || piece_index::text || '|' ||
                 coalesce(token_start::text, '') || '|' ||
                 coalesce(token_end::text, '') || '|' ||
                 coalesce(md5(text), ''),
               E'\n' order by piece_index
             )) as fingerprint
      from config_chunk_overrides
      where config_id = ${cfg.id}
      group by source_chunk_id
    `;
    return new Map(rows.map((r) => [r.source_chunk_id, r.fingerprint]));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return new Map();
    throw err;
  }
}

// Every override for the active config (chunk id + which model), for retrieval
// fan-out and UI badges. Called on every retrieval, so it tolerates the table
// not existing yet (migration 0013 unapplied): Postgres "undefined_table"
// (42P01) → no overrides, i.e. the app behaves exactly as pre-Phase-5 until 0013
// lands. Any other error propagates.
//
// Once per scope, under the fingerprint's key prefix so the same writers forget
// it (cut 3): every scoring call and every install read it — 49 times a press.
export async function listOverrides(): Promise<ChunkOverride[]> {
  const cfg = activeConfig();
  return scopeMemo(`fingerprint:list:${cfg.id}`, () => readOverrides(cfg));
}

async function readOverrides(
  cfg: ReturnType<typeof activeConfig>,
): Promise<ChunkOverride[]> {
  try {
    // DISTINCT: a chunk now has several piece rows, but one model + kind.
    const rows = await sql<
      { source_chunk_id: string; model: string; kind: string }[]
    >`
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
export async function getChunkOverridePieces(sourceChunkId: string): Promise<{
  model: string;
  kind: OverrideKind;
  pieces: OverridePiece[];
} | null> {
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
      select model, kind, text, dimension, embedding::real[] as embedding,
             token_start, token_end
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
//
// ⚠ THIS SHIPS VECTORS. A 1024-dim real[] renders to ~11 kB of text on the wire,
// so a whole config's pieces is a few hundred kB per call. NOTHING IN THE APP
// CALLS THIS ANY MORE: the retriever asks Postgres for the collapsed sims
// (overrideSims, below, docs/fusion-egress-plan.md §1.1) and the dirty screen
// asks it for per-pair sims (evalStore.screenSims, demo-egress-plan §1.4). The
// surviving callers are the two equivalence scripts, which keep a copy of the
// JS path precisely so they can compare it against the SQL one. A caller that
// does want raw vectors MUST pass `chunkIds` and download the handful it uses.
export async function overrideEmbeddings(
  model: string,
  chunkIds?: string[],
): Promise<OverrideEmbedding[]> {
  const cfg = activeConfig();
  if (chunkIds !== undefined && chunkIds.length === 0) return [];
  const only =
    chunkIds === undefined
      ? sql``
      : sql`and source_chunk_id = any(${chunkIds}::uuid[])`;
  const rows = await sql<{ source_chunk_id: string; embedding: number[] }[]>`
    select source_chunk_id, embedding::real[] as embedding
    from config_chunk_overrides
    where config_id = ${cfg.id} and model = ${model} ${only}
  `;
  return rows.map((r) => ({
    chunkId: r.source_chunk_id,
    embedding: r.embedding,
  }));
}

// The same candidate set, collapsed to the one number the merge actually consumes:
// the BEST piece sim per source chunk. Identical arithmetic to cosine-ing every
// piece in JS and keeping the max (retriever.fuseWithOverrides used to), computed
// where the vectors already live — ~300 kB per query per model becomes ~1 kB.
//
// Three things this depends on, none of them incidental:
//   • `embedding` IS pgvector since 0084 (it was real[], and both sides used to
//     need a ::vector cast — 162 ms per call over 232 pieces, re-parsed on every
//     scan). The query vector still arrives as a JS array, hence its own cast.
//     Reads that want the raw floats back ask for ::real[]; that direction is
//     exact, because pgvector stores float4 too.
//   • The table carries btree indexes only (no HNSW), so `<=>` scans exactly the
//     rows the JS loop scanned. Nothing here became ANN.
//   • `<=>` requires equal dimensions, and `model = $2` is what guarantees that:
//     pieces under different models are 384/1024/1536 wide. The model filter is
//     LOAD-BEARING; dropping it turns this into a runtime dimension error.
//
// `excludeChunkId` is the trial path's excluded chunk — a dry-run replaces that
// chunk's stored override with a hypothetical one, so its stored pieces must not
// compete. It used to be a JS `.filter` after the download; in the where clause it
// is free. scripts/fusion-equiv.ts replays both forms and asserts they agree.
// overrideSims for a WHOLE BATCH of queries under one model. One statement for
// what was one per question — see vectorStore.queryExcludingIdsBatch for why
// that is the number that matters on a pinned connection.
//
// No `excludeChunkId`: the exclusion is the trial dry-run's, and a trial scores
// ONE question against many rungs, which is the opposite shape. Batching is for
// the eval scorer, where no chunk is excluded.
export async function overrideSimsBatch(
  model: string,
  queryVectors: number[][],
): Promise<Map<string, number>[]> {
  if (queryVectors.length === 0) return [];
  const cfg = activeConfig();
  const literals = queryVectors.map((v) => `[${v.join(",")}]`);
  const rows = await sql<{ i: string; source_chunk_id: string; sim: number }[]>`
    select q.i, o.source_chunk_id,
           max(1 - (o.embedding <=> q.v)) as sim
    from unnest(${literals}::text[]::vector[]) with ordinality as q(v, i)
    cross join config_chunk_overrides o
    where o.config_id = ${cfg.id} and o.model = ${model}
    group by q.i, o.source_chunk_id
  `;
  const out: Map<string, number>[] = queryVectors.map(() => new Map());
  for (const r of rows)
    out[Number(r.i) - 1].set(r.source_chunk_id, Number(r.sim));
  return out;
}

// overrideSimsBatch for SEVERAL models in one statement (cut 4,
// docs/autotune-press-latency-plan.md §9): the prefetch used to issue one per
// delegate model — 2.5 per one-question call on a pinned connection. Each query
// vector travels with its model, and `o.model = q.model` is what keeps `<=>` on
// equal dimensions, exactly as the single-model `model = $2` filter did; the
// rows per model are the same rows, grouped the same way.
export async function overrideSimsMulti(
  byModel: { model: string; vectors: number[][] }[],
): Promise<Map<string, Map<string, number>[]>> {
  const out = new Map<string, Map<string, number>[]>();
  const models: string[] = [];
  const literals: string[] = [];
  const slot: { model: string; i: number }[] = [];
  for (const m of byModel) {
    out.set(
      m.model,
      m.vectors.map(() => new Map()),
    );
    m.vectors.forEach((v, i) => {
      models.push(m.model);
      literals.push(`[${v.join(",")}]`);
      slot.push({ model: m.model, i });
    });
  }
  if (literals.length === 0) return out;
  const cfg = activeConfig();
  const rows = await sql<{ i: string; source_chunk_id: string; sim: number }[]>`
    select q.i, o.source_chunk_id,
           max(1 - (o.embedding <=> q.v)) as sim
    from unnest(${models}::text[], ${literals}::text[]::vector[])
         with ordinality as q(model, v, i)
    join config_chunk_overrides o
      on o.config_id = ${cfg.id} and o.model = q.model
    group by q.i, o.source_chunk_id
  `;
  for (const r of rows) {
    const s = slot[Number(r.i) - 1];
    out.get(s.model)![s.i].set(r.source_chunk_id, Number(r.sim));
  }
  return out;
}

export async function overrideSims(
  model: string,
  queryVector: number[],
  excludeChunkId?: string | null,
): Promise<Map<string, number>> {
  const cfg = activeConfig();
  const exclude = excludeChunkId
    ? sql`and source_chunk_id <> ${excludeChunkId}::uuid`
    : sql``;
  const rows = await sql<{ source_chunk_id: string; sim: number }[]>`
    select source_chunk_id,
           max(1 - (embedding <=> ${queryVector}::real[]::vector)) as sim
    from config_chunk_overrides
    where config_id = ${cfg.id} and model = ${model} ${exclude}
    group by source_chunk_id
  `;
  return new Map(rows.map((r) => [r.source_chunk_id, Number(r.sim)]));
}
