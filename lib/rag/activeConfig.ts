// ---------------------------------------------------------------------------
// ACTIVE CONFIG — request-scoped RAG configuration.
//
// The app used to read a single hard-coded `config` (lib/config.ts) everywhere.
// With saved configs (the multi-config epic, see docs/multi-config-plan.md) the
// per-request config is resolved from the `configs` table and made available to
// the store/orchestration layer through an AsyncLocalStorage scope — so the deep
// SQL helpers can read `activeConfig()` without threading an argument through
// every call site.
//
// Route handlers wrap their work in `withConfig(await resolveRequestConfig(req),
// …)`. For streaming routes the scope must be entered INSIDE the stream producer
// (the ReadableStream.start callback runs after the handler returns — see
// lib/http/ndjson.ts), so withConfig is reusable at any layer.
//
// lib/config.ts remains the source of GLOBAL settings (upload limits, eval/
// ranking knobs) and the DEFAULTS used to seed new configs.
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "@/lib/db";
import { chunksTable, modelDimension } from "@/lib/rag/vectorStore";

// The fully-resolved settings for one config, derived once per request. The
// per-config fields mirror the names the old global `config` exposed, so call
// sites change from `config.x` to `activeConfig().x`.
export type ResolvedConfig = {
  id: string;
  corpusId: string | null; // null = detached from any corpus (0017)
  corpusSync: boolean;     // auto-sync membership with the corpus (0017)
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  // Live-retrieval fusion pool (0027): base candidates re-embedded per override
  // model to position fusion ranks. null = auto (max(top_k * 4, 50)).
  fusionPool: number | null;
  llmModel: string;
  dimension: number; // embedding dimension of the base model
  chunksTable: string; // chunks_<model>_<dim> table this config's vectors live in
};

const store = new AsyncLocalStorage<ResolvedConfig>();

// Build a ResolvedConfig from a `configs` row, deriving the embedding dimension
// and physical chunk table from the base model.
function toResolved(row: ConfigRow): ResolvedConfig {
  const dimension = modelDimension(row.base_model);
  return {
    id: row.id,
    corpusId: row.corpus_id,
    corpusSync: row.corpus_sync,
    embeddingModel: row.base_model,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    topK: row.top_k,
    fusionPool: row.retrieval_fusion_pool,
    llmModel: row.llm_model,
    dimension,
    chunksTable: chunksTable(row.base_model, dimension),
  };
}

type ConfigRow = {
  id: string;
  corpus_id: string | null;
  corpus_sync: boolean;
  base_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  retrieval_fusion_pool: number | null;
  llm_model: string;
};

// Config ids always come from our DB (uuids). Guard string lookups with this so
// a malformed id from a hand-typed URL or query param resolves to a clean
// not-found instead of crashing on a Postgres uuid cast (500).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// Resolve a specific config by id; null when malformed or it doesn't exist.
export async function resolveConfig(configId: string): Promise<ResolvedConfig | null> {
  if (!isUuid(configId)) return null;
  const rows = await sql<ConfigRow[]>`
    select id, corpus_id, corpus_sync, base_model, chunk_size, chunk_overlap, top_k,
           retrieval_fusion_pool, llm_model
    from configs
    where id = ${configId}
    limit 1
  `;
  return rows.length > 0 ? toResolved(rows[0]) : null;
}

// The config to use when a request doesn't name one. Until the tabs UI lands
// (Phase 2) there's a single Default config from the 0011 backfill; pick the
// earliest as a stable default.
export async function resolveDefaultConfig(): Promise<ResolvedConfig> {
  const rows = await sql<ConfigRow[]>`
    select id, corpus_id, corpus_sync, base_model, chunk_size, chunk_overlap, top_k,
           retrieval_fusion_pool, llm_model
    from configs
    order by created_at
    limit 1
  `;
  if (rows.length === 0) {
    throw new Error(
      "No config exists. Apply migrations 0010/0011 (they backfill a Default config).",
    );
  }
  return toResolved(rows[0]);
}

// Resolve the active config for an incoming request: an explicit configId
// (query param or x-config-id header) wins; otherwise the default. Throws when
// an explicit id doesn't resolve, so a bad tab id fails loudly rather than
// silently scoring against the wrong corpus.
export async function resolveRequestConfig(request: Request): Promise<ResolvedConfig> {
  const fromQuery = new URL(request.url).searchParams.get("configId");
  const configId = fromQuery ?? request.headers.get("x-config-id");
  if (!configId) return resolveDefaultConfig();
  const resolved = await resolveConfig(configId);
  if (!resolved) throw new Error(`Unknown configId "${configId}".`);
  return resolved;
}

// Run `fn` with `resolved` as the active config. Everything awaited inside the
// same async chain (including deep store calls) sees it via activeConfig().
export function withConfig<T>(resolved: ResolvedConfig, fn: () => Promise<T>): Promise<T> {
  return store.run(resolved, fn);
}

// The active config for the current scope. Throws when called outside withConfig
// — a programming error (a store call that escaped the request scope).
export function activeConfig(): ResolvedConfig {
  const cfg = store.getStore();
  if (!cfg) {
    throw new Error("activeConfig() called outside a withConfig() scope.");
  }
  return cfg;
}
