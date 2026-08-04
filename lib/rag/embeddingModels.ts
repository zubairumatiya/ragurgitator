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
  // Curated: models that emit into the SAME, cosine-comparable embedding space
  // share one `vectorSpace` tag. When a delegate override's model shares the
  // base model's space, live retrieval could compare it directly instead of
  // opening a separate rank-fusion lane (retriever.fuseWithOverrides) — the win
  // the autotune "Models" checklist surfaces by grouping same-space models
  // apart. Undefined = its own private space (always fused). This is an app
  // claim about the provider's models, not something we can probe — verify
  // against the provider's docs before adding a model to an existing space.
  vectorSpace?: string;
};

// `dimension` is load-bearing only for ingestable models (it picks the physical
// vector table) and for the OpenAI adapter (the `dimensions` shrink param). For
// the non-ingestable Voyage alts it's informational — embed() doesn't read it.
export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  // --- Voyage: the default + the alternates used by the in-memory experiments
  //     (altEmbeddingModels in lib/config.ts; the nDCG aggregate votes with
  //     every keyed model — see keyedModels below) ------------------------
  // The voyage-4 family shares one embedding space (space "voyage-4"): a chunk
  // re-embedded under voyage-4 / voyage-4-large stays cosine-comparable to the
  // voyage-4-lite base, so an override under them needs no fusion lane.
  "voyage-4-lite": { id: "voyage-4-lite", provider: "voyage", apiModel: "voyage-4-lite", dimension: 1024, ingestable: true, vectorSpace: "voyage-4" },
  "voyage-4-large": { id: "voyage-4-large", provider: "voyage", apiModel: "voyage-4-large", dimension: 1024, ingestable: false, vectorSpace: "voyage-4" },
  "voyage-4": { id: "voyage-4", provider: "voyage", apiModel: "voyage-4", dimension: 1024, ingestable: false, vectorSpace: "voyage-4" },
  "voyage-code-3": { id: "voyage-code-3", provider: "voyage", apiModel: "voyage-code-3", dimension: 1024, ingestable: false },
  "voyage-code-2": { id: "voyage-code-2", provider: "voyage", apiModel: "voyage-code-2", dimension: 1536, ingestable: false },
  "voyage-finance-2": { id: "voyage-finance-2", provider: "voyage", apiModel: "voyage-finance-2", dimension: 1024, ingestable: false },
  "voyage-law-2": { id: "voyage-law-2", provider: "voyage", apiModel: "voyage-law-2", dimension: 1024, ingestable: false },

  // --- Staged plumbing: usable in experiments once a key/weights are present;
  //     flip `ingestable` + add a 0012+ migration to index under them ----------
  // Each of these is its own embedding space. A `vectorSpace` groups models that
  // are cosine-comparable; across providers that only ever holds for one model's
  // Matryoshka output dimensions (OpenAI's `dimensions` / Cohere's
  // `output_dimension` truncate ONE model, staying in its space — a shorter
  // vector is a prefix of the longer one), never across different models (OpenAI
  // large ≠ small; Cohere v4 ≠ v3). So today every entry below is a single-member
  // space: the tag matters only when a second Matryoshka dim-variant of the SAME
  // model is added — it then auto-clusters with this one (no fusion between them).
  "mxbai-embed-large": { id: "mxbai-embed-large", provider: "local", apiModel: "Xenova/mxbai-embed-large-v1", dimension: 1024, ingestable: true, vectorSpace: "mxbai-embed-large-v1" },
  "bge-m3": { id: "bge-m3", provider: "local", apiModel: "Xenova/bge-m3", dimension: 1024, ingestable: true, vectorSpace: "bge-m3" },
  // native 3072; shrunk to 1024 via the `dimensions` param (Matryoshka, E7) so it
  // stays under pgvector's HNSW cap and is ingestable later without re-deciding.
  "text-embedding-3-large": { id: "text-embedding-3-large", provider: "openai", apiModel: "text-embedding-3-large", dimension: 1024, ingestable: false, vectorSpace: "openai-text-embedding-3-large" },
  "embed-v4": { id: "embed-v4", provider: "cohere", apiModel: "embed-v4.0", dimension: 1536, ingestable: false, vectorSpace: "cohere-embed-v4" },
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

// Do these two models emit into the same cosine-comparable space? True when
// they're the same model, or share a non-null `vectorSpace` tag. The retriever
// uses this to FOLD a same-space override into the base lane (retriever.ts):
// its pieces are ranked directly against the base query vector, so no separate
// fusion lane, query re-embedding, or pool re-embedding is needed. Null-safe:
// an unknown id (no registry entry) has no space, so it never folds — it takes
// the ordinary foreign-space fusion path, exactly as before.
export function sameVectorSpace(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = EMBEDDING_MODELS[a]?.vectorSpace;
  const sb = EMBEDDING_MODELS[b]?.vectorSpace;
  return sa != null && sa === sb;
}

// --- Provider availability (drives the base-model picker's grey-out) ---------
// Which env var enables each provider. API providers: their credential. Local
// models need no key, but they download multi-hundred-MB weights on first use
// and can't run on serverless hosts — so they're opt-in behind LOCAL_EMBEDDINGS
// (set to any non-empty value in environments that can run them).
const PROVIDER_KEY_ENV: Record<EmbeddingProviderId, string> = {
  voyage: "VOYAGE_API_KEY",
  openai: "OPENAI_API_KEY",
  cohere: "COHERE_API_KEY",
  local: "LOCAL_EMBEDDINGS",
};

// Is this provider usable right now? Its enabling env var is non-empty.
// Server-only (reads process.env) — call it from a route/server component.
export function isProviderAvailable(provider: EmbeddingProviderId): boolean {
  return Boolean(process.env[PROVIDER_KEY_ENV[provider]]);
}

// Which env var enables a provider, for "set VOYAGE_API_KEY to enable" copy.
// Exported so callers outside this module (the Appraise → Models rate card,
// which lists every model rather than just the config-picker candidates) can
// explain an unavailable provider without duplicating the mapping.
export function providerKeyEnv(provider: EmbeddingProviderId): string {
  return PROVIDER_KEY_ENV[provider];
}

export type BaseModelOption = {
  id: string;
  label: string;
  provider: EmbeddingProviderId;
  dimension: number;
  // selectable = has a chunks table (ingestable) AND its provider is available.
  selectable: boolean;
  // Why it's NOT selectable, for the greyed-out tooltip; null when selectable.
  reason: string | null;
};

// Base-model options for the config picker: each candidate model with whether it
// can be picked for real ingestion right now. The picker greys out the ones that
// aren't `selectable`, showing `reason` (missing key, or no vector table yet).
//
// "Candidate" excludes the extra Voyage entries (voyage-4-large, etc.) — those
// exist only for the in-memory try-a-model experiment (altEmbeddingModels), not
// as ingestion targets. The rule: any ingestable model, plus any non-Voyage
// provider (local/OpenAI/Cohere) we'd set up to ingest under.
export function listBaseModelOptions(): BaseModelOption[] {
  return Object.values(EMBEDDING_MODELS)
    .filter((spec) => spec.ingestable || spec.provider !== "voyage")
    .map((spec) => {
    const available = isProviderAvailable(spec.provider);
    const reasons: string[] = [];
    if (!available) reasons.push(`set ${PROVIDER_KEY_ENV[spec.provider]} to enable`);
    if (!spec.ingestable) reasons.push("no vector table yet (add a migration)");
    return {
      id: spec.id,
      label: spec.id,
      provider: spec.provider,
      dimension: spec.dimension,
      selectable: spec.ingestable && available,
      reason: reasons.length > 0 ? reasons.join("; ") : null,
    };
  });
}

// --- Autotune "Models" checklist options -------------------------------------
// One alternate model the autotune engine could try, for the Settings checklist.
export type AutotuneModelOption = {
  id: string;
  provider: EmbeddingProviderId;
  vectorSpace: string | null;
  // Shares the base model's embedding space → an override under it needs no
  // extra fusion lane. Drives the checklist's "same space" subsection.
  sameSpaceAsBase: boolean;
  // selectable = its provider is keyed, so a run could actually use it today.
  // Same `selectable`/`reason` pair as BaseModelOption, for the same reason: an
  // unkeyed model is LISTED (greyed out) rather than dropped, so the checklist
  // explains why a space is missing instead of silently showing one group.
  selectable: boolean;
  // Why it's NOT selectable ("set OPENAI_API_KEY to enable"); null when it is.
  reason: string | null;
};

// The models the nDCG "Models in aggregate" checklist offers (0045): every
// registry model, in registry order.
//
// Unlike the autotune list this INCLUDES the config's base model — it votes in
// the aggregate like any other (buildAggregate reuses its already-computed
// similarities rather than re-embedding), and excluding it from the picker would
// make the default set unrepresentable in the UI.
//
// Same selectable/reason contract as the autotune options: an unkeyed model is
// listed greyed out with the env var that would enable it, rather than dropped.
export function listAggregateModelOptions(baseModel: string): AutotuneModelOption[] {
  const baseSpace = EMBEDDING_MODELS[baseModel]?.vectorSpace ?? null;
  return Object.values(EMBEDDING_MODELS).map((spec) => {
    const available = isProviderAvailable(spec.provider);
    const space = spec.vectorSpace ?? null;
    return {
      id: spec.id,
      provider: spec.provider,
      vectorSpace: space,
      sameSpaceAsBase: space !== null && space === baseSpace,
      selectable: available,
      reason: available ? null : `set ${PROVIDER_KEY_ENV[spec.provider]} to enable`,
    };
  });
}

// Every model we could embed with RIGHT NOW: registry order, provider keyed.
//
// This is what a null `ndcg_aggregate_models` resolves to (migration 0045) — the
// nDCG aggregate's default is "every candidate votes", not a hard-coded list.
// That also keeps the Settings checklist honest: it collapses an all-checked box
// set to null, so null must mean the same thing as all-checked or ticking
// everything would silently narrow the aggregate.
//
// Note this widens automatically when a provider gains a key. That's the
// intended "all" semantics, and it only affects rankings built from then on —
// but it does mean setting LOCAL_EMBEDDINGS opts local models (large weight
// downloads) into every subsequent aggregate build. Pin an explicit list in
// Settings to avoid that.
export function keyedModels(): string[] {
  return Object.values(EMBEDDING_MODELS)
    .filter((spec) => isProviderAvailable(spec.provider))
    .map((spec) => spec.id);
}

// Canonical ORDER for a set of model ids: registry order, not the order a user
// happened to click them. buildAggregate folds per-model ranks in a declared
// sequence and breaks rank-sum ties with a secondary key, so the same selection
// must always produce the same ideal — a stored click order would make the
// ranking depend on how the checkboxes were ticked.
export function canonicalModelOrder(ids: string[]): string[] {
  const wanted = new Set(ids);
  return Object.keys(EMBEDDING_MODELS).filter((id) => wanted.has(id));
}

// The alternate models the autotune checklist offers. Cheapest-first ladder
// order, minus the config's own base model. Everything else in the ladder is
// returned — the keyed models a run could use now (selectable), plus the ones
// whose provider has no key/weights, flagged with the env var that would enable
// them so the UI can grey them out with a reason.
//
// The ENGINE keeps its own eligibility check (autotune.usableModelLadder
// intersects the saved scope with the keyed ladder), so a stale unkeyed id in a
// saved scope can never be run; this list is purely what the picker shows.
// `baseModel` is the config's base (its space defines sameSpaceAsBase). The
// caller passes the ladder (lib/config.autotuneModelLadder) to avoid a
// config → registry import cycle.
export function listAutotuneModelOptions(
  ladder: string[],
  baseModel: string,
): AutotuneModelOption[] {
  const baseSpace = EMBEDDING_MODELS[baseModel]?.vectorSpace ?? null;
  const options: AutotuneModelOption[] = [];
  for (const id of ladder) {
    if (id === baseModel) continue;
    const spec = EMBEDDING_MODELS[id];
    if (!spec) continue; // not in the registry — nothing to embed with
    const available = isProviderAvailable(spec.provider);
    const space = spec.vectorSpace ?? null;
    options.push({
      id,
      provider: spec.provider,
      vectorSpace: space,
      sameSpaceAsBase: space !== null && space === baseSpace,
      selectable: available,
      reason: available ? null : `set ${PROVIDER_KEY_ENV[spec.provider]} to enable`,
    });
  }
  return options;
}
