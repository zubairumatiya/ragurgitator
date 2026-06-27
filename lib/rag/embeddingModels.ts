// ---------------------------------------------------------------------------
// EMBEDDING MODEL REGISTRY — the single source of truth for every embedding
// model the app knows about (see docs/embedding-providers-plan.md, decision E1).
//
// One entry maps a canonical model id to its provider, the provider's real model
// name, its output dimension, and whether it's wired for REAL ingestion (Tier B
// — has a chunks_<model>_<dim> table + migration). Everything that used to
// hard-code "Voyage" reads this:
//   - embeddings.embed()         picks the provider adapter (lib/rag/embeddingProviders.ts)
//   - vectorStore.modelDimension/chunksTable   resolve dim + physical table
//   - activeConfig.toResolved()  builds a ResolvedConfig from a config's base_model
//
// Two tiers (E6): a model is usable in the in-memory experiments (try-a-model,
// nDCG aggregate) the moment its adapter routes — no DB, any dim. Making it a
// config's base_model (real ingestion) additionally needs `ingestable: true`, a
// chunksTable() case, and a chunks_<model>_<dim> migration.
// ---------------------------------------------------------------------------
export type EmbeddingProviderId = "voyage" | "openai" | "cohere" | "local";

export type EmbeddingModelSpec = {
  id: string; // canonical id (config.embeddingModel, chunksTable key, alt lists)
  provider: EmbeddingProviderId;
  apiModel: string; // the provider's real model name / HF repo id
  dimension: number; // native, or the chosen output dim (e.g. OpenAI Matryoshka)
  ingestable: boolean; // true ⇒ has a chunks_<model>_<dim> table + migration (Tier B)
};

// `dimension` is load-bearing only for ingestable models (it picks the physical
// vector table) and for the OpenAI adapter (the `dimensions` shrink param). For
// the non-ingestable Voyage alts it's informational — embed() doesn't read it.
export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  // --- Voyage: the default + the alternates used by the in-memory experiments
  //     (altEmbeddingModels / rankingAggregateModels in lib/config.ts) ---------
  "voyage-4-lite": { id: "voyage-4-lite", provider: "voyage", apiModel: "voyage-4-lite", dimension: 1024, ingestable: true },
  "voyage-4-large": { id: "voyage-4-large", provider: "voyage", apiModel: "voyage-4-large", dimension: 1024, ingestable: false },
  "voyage-4": { id: "voyage-4", provider: "voyage", apiModel: "voyage-4", dimension: 1024, ingestable: false },
  "voyage-code-3": { id: "voyage-code-3", provider: "voyage", apiModel: "voyage-code-3", dimension: 1024, ingestable: false },
  "voyage-code-2": { id: "voyage-code-2", provider: "voyage", apiModel: "voyage-code-2", dimension: 1536, ingestable: false },
  "voyage-finance-2": { id: "voyage-finance-2", provider: "voyage", apiModel: "voyage-finance-2", dimension: 1024, ingestable: false },
  "voyage-law-2": { id: "voyage-law-2", provider: "voyage", apiModel: "voyage-law-2", dimension: 1024, ingestable: false },

  // --- Staged plumbing: usable in experiments once a key/weights are present;
  //     flip `ingestable` + add a 0012+ migration to index under them ----------
  "mxbai-embed-large": { id: "mxbai-embed-large", provider: "local", apiModel: "Xenova/mxbai-embed-large-v1", dimension: 1024, ingestable: false },
  "bge-m3": { id: "bge-m3", provider: "local", apiModel: "Xenova/bge-m3", dimension: 1024, ingestable: false },
  // native 3072; shrunk to 1024 via the `dimensions` param (Matryoshka, E7) so it
  // stays under pgvector's HNSW cap and is ingestable later without re-deciding.
  "text-embedding-3-large": { id: "text-embedding-3-large", provider: "openai", apiModel: "text-embedding-3-large", dimension: 1024, ingestable: false },
  "embed-v4": { id: "embed-v4", provider: "cohere", apiModel: "embed-v4.0", dimension: 1536, ingestable: false },
};

// Look up a model spec, failing loudly on an unknown id (a missing registry
// entry, not a silent wrong default).
export function modelSpec(id: string): EmbeddingModelSpec {
  const spec = EMBEDDING_MODELS[id];
  if (!spec) {
    throw new Error(`Unknown embedding model "${id}". Add it to EMBEDDING_MODELS.`);
  }
  return spec;
}
