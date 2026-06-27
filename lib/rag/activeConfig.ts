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
  corpusId: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  llmModel: string;
  dimension: number; // embedding dimension of the base model
  chunksTable: string; // chunks_<model>_<dim> table this config's vectors live in
};

const store = new AsyncLocalStorage<ResolvedConfig>();

// Build a ResolvedConfig from a `configs` row, deriving the embedding dimension
// and physical chunk table from the base model.
function toResolved(row: {
  id: string;
  corpus_id: string;
  base_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  llm_model: string;
}): ResolvedConfig {
  const dimension = modelDimension(row.base_model);
  return {
    id: row.id,
    corpusId: row.corpus_id,
    embeddingModel: row.base_model,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    topK: row.top_k,
    llmModel: row.llm_model,
    dimension,
    chunksTable: chunksTable(row.base_model, dimension),
  };
}

type ConfigRow = {
  id: string;
  corpus_id: string;
  base_model: string;
  chunk_size: number;
  chunk_overlap: number;
  top_k: number;
  llm_model: string;
};

// Resolve a specific config by id; null when it doesn't exist.
export async function resolveConfig(configId: string): Promise<ResolvedConfig | null> {
  const rows = await sql<ConfigRow[]>`
    select id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model
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
    select id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model
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
