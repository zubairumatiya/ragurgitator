// EMBEDDING MODEL REGISTRY — the single source of truth for every embedding model
// the app knows about. One entry maps a canonical model id to its provider, the
// provider's real model name, its output dimension, and whether it's wired for
// real ingestion.
//
// Two tiers: a model is usable in the in-memory experiments (try-a-model, nDCG
// aggregate) the moment its adapter routes — no DB, any dim. Making it a config's
// base_model additionally needs `ingestable: true`, a chunksTable() case, and a
// chunks_<model>_<dim> migration.
export type EmbeddingProviderId = "voyage" | "openai" | "cohere" | "local";

export type EmbeddingModelSpec = {
  id: string; // canonical id (config.embeddingModel, chunksTable key, alt lists)
  provider: EmbeddingProviderId;
  apiModel: string; // the provider's real model name / HF repo id
  dimension: number; // native, or the chosen output dim (e.g. OpenAI Matryoshka)
  // What `apiModel` returns when we send NO shrink parameter. `dimension` is what
  // we WANT; `nativeDimension` is what we'd get by default; the adapters send a
  // shrink param (OpenAI `dimensions`, Cohere `output_dimension`) exactly when the
  // two differ.
  //
  // A field rather than a constant because that comparison used to be a literal
  // `< 3072` — right for text-embedding-3-large and wrong for every other
  // Matryoshka model, sending a redundant dim to some and an invalid above-native
  // dim to any model registered between its native size and 3072.
  nativeDimension: number;
  ingestable: boolean; // true ⇒ has a chunks_<model>_<dim> table + migration (Tier B)
  // Models that emit into the SAME, cosine-comparable space share one `vectorSpace`
  // tag, letting a delegate override be compared directly instead of opening a
  // rank-fusion lane (retriever.fuseWithOverrides). Undefined = its own private
  // space (always fused). This is an app claim about the provider's models, not
  // something we can probe — verify against the provider's docs before adding a
  // model to an existing space.
  vectorSpace?: string;
  // A caveat the pickers show beside this model: a real limit that makes it a BAD
  // FIT for some configs, as opposed to a reason it can't be used at all (that's
  // the option builders' `reason`, which greys the row out). A note never blocks a
  // selection.
  //
  // WRITE IT AS "headline: detail" — pickers render noteHeadline() inline and hang
  // the full text off the row's tooltip. A note with no colon is its own headline.
  note?: string;
};

// The part of a `note` before its first colon, kept beside the convention it
// depends on so a picker can't invent its own truncation.
export function noteHeadline(note: string): string {
  const colon = note.indexOf(":");
  return colon === -1 ? note : note.slice(0, colon);
}

// One shared note for the four Cohere v3 models, which cap input at 512 tokens
// (v4 takes 128K). Stated in CHARACTERS because that's the unit a config's chunk
// size is in — ~4 chars/token, the same estimate pricing.ts uses.
const COHERE_V3_INPUT_CAP_NOTE =
  "512-token input cap (~2,000 characters): longer chunks are truncated to their opening ~2,000 characters, so this model is a poor fit for configs chunked larger than that.";

// `dimension` is load-bearing only for ingestable models (it picks the physical
// vector table) and for the adapters that can shrink a Matryoshka model to it,
// each sending the param only when `dimension < nativeDimension`. For the
// non-ingestable Voyage alts it's informational — embed() doesn't read it.
export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  // The voyage-4 family shares one embedding space: a chunk re-embedded under
  // voyage-4 / voyage-4-large stays cosine-comparable to the voyage-4-lite base, so
  // an override under them needs no fusion lane. The Voyage adapter never sends an
  // output-dimension param, so dimension === nativeDimension throughout.
  "voyage-4-lite": { id: "voyage-4-lite", provider: "voyage", apiModel: "voyage-4-lite", dimension: 1024, nativeDimension: 1024, ingestable: true, vectorSpace: "voyage-4" },
  "voyage-4-large": { id: "voyage-4-large", provider: "voyage", apiModel: "voyage-4-large", dimension: 1024, nativeDimension: 1024, ingestable: false, vectorSpace: "voyage-4" },
  "voyage-4": { id: "voyage-4", provider: "voyage", apiModel: "voyage-4", dimension: 1024, nativeDimension: 1024, ingestable: false, vectorSpace: "voyage-4" },
  "voyage-code-3": { id: "voyage-code-3", provider: "voyage", apiModel: "voyage-code-3", dimension: 1024, nativeDimension: 1024, ingestable: false },
  "voyage-code-2": { id: "voyage-code-2", provider: "voyage", apiModel: "voyage-code-2", dimension: 1536, nativeDimension: 1536, ingestable: false },
  "voyage-finance-2": { id: "voyage-finance-2", provider: "voyage", apiModel: "voyage-finance-2", dimension: 1024, nativeDimension: 1024, ingestable: false },
  "voyage-law-2": { id: "voyage-law-2", provider: "voyage", apiModel: "voyage-law-2", dimension: 1024, nativeDimension: 1024, ingestable: false },

  // Staged plumbing: usable in experiments once a key/weights are present; flip
  // `ingestable` + add a migration to index under them.
  //
  // Across providers a shared `vectorSpace` only ever holds for one model's
  // Matryoshka output dimensions (a shorter vector is a prefix of the longer one),
  // never across different models. `embed-v4` + `embed-v4-1024` are the first pair
  // to exercise that: two rows, one model, one space. Every other entry here is a
  // single-member space until a dim-variant of THAT model lands.
  "mxbai-embed-large": { id: "mxbai-embed-large", provider: "local", apiModel: "Xenova/mxbai-embed-large-v1", dimension: 1024, nativeDimension: 1024, ingestable: true, vectorSpace: "mxbai-embed-large-v1" },
  "bge-m3": { id: "bge-m3", provider: "local", apiModel: "Xenova/bge-m3", dimension: 1024, nativeDimension: 1024, ingestable: true, vectorSpace: "bge-m3" },
  // Native 3072; shrunk to 1024 via the `dimensions` param so it stays under
  // pgvector's HNSW cap and is ingestable later without re-deciding.
  "text-embedding-3-large": { id: "text-embedding-3-large", provider: "openai", apiModel: "text-embedding-3-large", dimension: 1024, nativeDimension: 3072, ingestable: false, vectorSpace: "openai-text-embedding-3-large" },
  // Registered AT its native 1536, so no `dimensions` param goes out — a different
  // space from *large* despite the shared family name (a 1024-wide large vector and
  // a 1536-wide small vector describe nothing in common).
  "text-embedding-3-small": { id: "text-embedding-3-small", provider: "openai", apiModel: "text-embedding-3-small", dimension: 1536, nativeDimension: 1536, ingestable: false, vectorSpace: "openai-text-embedding-3-small" },
  // Cohere v4 at its default width, and the same model asked for a 1024 prefix.
  "embed-v4": { id: "embed-v4", provider: "cohere", apiModel: "embed-v4.0", dimension: 1536, nativeDimension: 1536, ingestable: false, vectorSpace: "cohere-embed-v4" },
  "embed-v4-1024": { id: "embed-v4-1024", provider: "cohere", apiModel: "embed-v4.0", dimension: 1024, nativeDimension: 1536, ingestable: false, vectorSpace: "cohere-embed-v4" },
  // The Cohere v3 family: four separate models, four separate spaces, and a
  // 512-token input cap where v4 takes 128K. The light variants' 384 dims are the
  // smallest vectors this registry offers, which is what earns them a place.
  //
  // The adapter truncates rather than erroring, so over ~2,000 characters these
  // models quietly describe only the HEAD of each chunk — a silent quality loss
  // that looks like a bad model rather than a bad fit. Hence the note.
  "embed-english-v3": { id: "embed-english-v3", provider: "cohere", apiModel: "embed-english-v3.0", dimension: 1024, nativeDimension: 1024, ingestable: false, vectorSpace: "cohere-embed-english-v3", note: COHERE_V3_INPUT_CAP_NOTE },
  "embed-multilingual-v3": { id: "embed-multilingual-v3", provider: "cohere", apiModel: "embed-multilingual-v3.0", dimension: 1024, nativeDimension: 1024, ingestable: false, vectorSpace: "cohere-embed-multilingual-v3", note: COHERE_V3_INPUT_CAP_NOTE },
  "embed-english-light-v3": { id: "embed-english-light-v3", provider: "cohere", apiModel: "embed-english-light-v3.0", dimension: 384, nativeDimension: 384, ingestable: false, vectorSpace: "cohere-embed-english-light-v3", note: COHERE_V3_INPUT_CAP_NOTE },
  "embed-multilingual-light-v3": { id: "embed-multilingual-light-v3", provider: "cohere", apiModel: "embed-multilingual-light-v3.0", dimension: 384, nativeDimension: 384, ingestable: false, vectorSpace: "cohere-embed-multilingual-light-v3", note: COHERE_V3_INPUT_CAP_NOTE },
};

// Fail loudly on an unknown id — a missing registry entry, not a silent default.
export function modelSpec(id: string): EmbeddingModelSpec {
  const spec = EMBEDDING_MODELS[id];
  if (!spec) {
    throw new Error(`Unknown embedding model "${id}". Add it to EMBEDDING_MODELS.`);
  }
  return spec;
}

// Do these two models emit into the same cosine-comparable space? True when
// they're the same model, or share a non-null `vectorSpace` tag. The retriever
// uses this to FOLD a same-space override into the base lane, needing no fusion
// lane, query re-embedding, or pool re-embedding. Null-safe: an unknown id has no
// space, so it never folds.
export function sameVectorSpace(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = EMBEDDING_MODELS[a]?.vectorSpace;
  const sb = EMBEDDING_MODELS[b]?.vectorSpace;
  return sa != null && sa === sb;
}

// Under strict BYOK, provider availability is a property of the USER, resolved
// from user_provider_keys. That answer is async and needs a DB read, so it lives
// in lib/rag/providerAvailability.ts — this module stays a pure data table any
// layer can import.
//
// Every function below therefore takes the resolved set as its first argument, so
// callers resolve once per render rather than once per model. Structural rather
// than `ReadonlySet<EmbeddingProviderId>` on purpose: the same resolved set
// answers for LLM providers too, so one lookup serves both registries.
export type ProviderAvailability = { has(provider: string): boolean };

// Why a provider is unavailable, phrased as the action that would fix it.
//
// The two cases are worded differently on purpose. An API provider needs a
// CREDENTIAL, which the user adds on the Account page. `local` needs a HOST
// CAPABILITY — transformers.js downloads multi-hundred-MB weights and can't run
// on a serverless function — which only an operator can grant. Telling a user to
// "add a local key in Settings" would send them somewhere that cannot help them.
export function unavailableReason(provider: EmbeddingProviderId): string {
  switch (provider) {
    case "openai":
      return "add an OpenAI key in Settings";
    case "cohere":
      return "add a Cohere key in Settings";
    case "voyage":
      return "add a Voyage key in Settings";
    case "local":
      return "set LOCAL_EMBEDDINGS to enable";
  }
}

export type BaseModelOption = {
  id: string;
  label: string;
  provider: EmbeddingProviderId;
  dimension: number;
  // A note is NOT a reason: it never blocks a selection, it explains a trade-off.
  note: string | null;
  // selectable = has a chunks table (ingestable) AND its provider is available.
  selectable: boolean;
  // Why it's NOT selectable, for the greyed-out tooltip; null when selectable.
  reason: string | null;
};

// Base-model options for the config picker: each candidate model with whether it
// can be picked for real ingestion right now, greying out the rest with `reason`.
//
// "Candidate" excludes the extra Voyage entries, which exist only for the
// in-memory try-a-model experiment: any ingestable model, plus any non-Voyage
// provider we'd set up to ingest under.
export function listBaseModelOptions(availability: ProviderAvailability): BaseModelOption[] {
  return Object.values(EMBEDDING_MODELS)
    .filter((spec) => spec.ingestable || spec.provider !== "voyage")
    .map((spec) => {
    const available = availability.has(spec.provider);
    const reasons: string[] = [];
    if (!available) reasons.push(unavailableReason(spec.provider));
    if (!spec.ingestable) reasons.push("no vector table yet (add a migration)");
    return {
      id: spec.id,
      label: spec.id,
      provider: spec.provider,
      dimension: spec.dimension,
      note: spec.note ?? null,
      selectable: spec.ingestable && available,
      reason: reasons.length > 0 ? reasons.join("; ") : null,
    };
  });
}

// One alternate model the in-memory trial could re-embed a chunk under.
export type TrialModelOption = {
  id: string;
  label: string;
  provider: EmbeddingProviderId;
  dimension: number;
  // Never greys the row out — that's `reason`.
  note: string | null;
  // selectable = its provider is keyed, so the trial could actually run.
  selectable: boolean;
  reason: string | null;
};

// Every registry model except the config's own (the baseline it's measured
// against), in registry order.
//
// THE TRIAL IS TIER A: it re-embeds a small candidate pool in memory and ranks by
// cosine, so `ingestable` is irrelevant and any output dimension works — which is
// why this offers strictly more than listBaseModelOptions. An unkeyed model is
// listed greyed out with its reason rather than dropped, so "this app does not
// support Cohere" stays distinguishable from "you have not added a Cohere key".
export function listTrialModelOptions(
  availability: ProviderAvailability,
  baseModel: string,
): TrialModelOption[] {
  return Object.values(EMBEDDING_MODELS)
    .filter((spec) => spec.id !== baseModel)
    .map((spec) => {
      const available = availability.has(spec.provider);
      return {
        id: spec.id,
        label: spec.provider === "voyage" ? spec.id : `${spec.id} (${spec.provider})`,
        provider: spec.provider,
        dimension: spec.dimension,
        note: spec.note ?? null,
        selectable: available,
        reason: available ? null : unavailableReason(spec.provider),
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
  // Why it's NOT selectable ("add an OpenAI key in Settings"); null when it is.
  reason: string | null;
  // The spec's caveat, on the same terms as BaseModelOption.note: shown beside
  // the row, never a reason to grey it out.
  note: string | null;
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
// listed greyed out with the action that would enable it (add a key on the
// Account page, or LOCAL_EMBEDDINGS for local weights), rather than dropped.
export function listAggregateModelOptions(
  availability: ProviderAvailability,
  baseModel: string,
): AutotuneModelOption[] {
  const baseSpace = EMBEDDING_MODELS[baseModel]?.vectorSpace ?? null;
  return Object.values(EMBEDDING_MODELS).map((spec) => {
    const available = availability.has(spec.provider);
    const space = spec.vectorSpace ?? null;
    return {
      id: spec.id,
      provider: spec.provider,
      vectorSpace: space,
      sameSpaceAsBase: space !== null && space === baseSpace,
      selectable: available,
      reason: available ? null : unavailableReason(spec.provider),
      note: spec.note ?? null,
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
export function keyedModels(availability: ProviderAvailability): string[] {
  return Object.values(EMBEDDING_MODELS)
    .filter((spec) => availability.has(spec.provider))
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
// whose provider has no key/weights, flagged with the action that would enable
// them so the UI can grey them out with a reason.
//
// The ENGINE keeps its own eligibility check (autotune.usableModelLadder
// intersects the saved scope with the keyed ladder), so a stale unkeyed id in a
// saved scope can never be run; this list is purely what the picker shows.
// `baseModel` is the config's base (its space defines sameSpaceAsBase). The
// caller passes the ladder (lib/config.autotuneModelLadder) to avoid a
// config → registry import cycle.
export function listAutotuneModelOptions(
  availability: ProviderAvailability,
  ladder: string[],
  baseModel: string,
): AutotuneModelOption[] {
  const baseSpace = EMBEDDING_MODELS[baseModel]?.vectorSpace ?? null;
  const options: AutotuneModelOption[] = [];
  for (const id of ladder) {
    if (id === baseModel) continue;
    const spec = EMBEDDING_MODELS[id];
    if (!spec) continue; // not in the registry — nothing to embed with
    const available = availability.has(spec.provider);
    const space = spec.vectorSpace ?? null;
    options.push({
      id,
      provider: spec.provider,
      vectorSpace: space,
      sameSpaceAsBase: space !== null && space === baseSpace,
      selectable: available,
      reason: available ? null : unavailableReason(spec.provider),
      note: spec.note ?? null,
    });
  }
  return options;
}
