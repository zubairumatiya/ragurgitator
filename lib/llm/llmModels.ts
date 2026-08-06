// ---------------------------------------------------------------------------
// LLM MODEL REGISTRY — the single source of truth for every ANSWER-GENERATION
// model the app knows about (docs/user-accounts-plan.md §9.1). Deliberately the
// same shape as lib/rag/embeddingModels.ts so there is ONE registry idiom in the
// codebase: a pure data table, a `<thing>Spec(id)` lookup that throws on an
// unknown id, and option builders that take a resolved availability set and
// return the `selectable`/`reason` pair every picker already renders.
//
// Pure on purpose — no `server-only`, no IO. Availability under strict BYOK is a
// per-user DB question (lib/rag/providerAvailability.ts); it is passed IN so that
// this module stays importable from a client component and so a picker costs one
// query per render rather than one per model.
//
// PROVIDER IS DERIVED FROM THE MODEL ID, never stored twice. `configs.llm_model`
// holds the provider's own API id, and those ids are already namespaced —
// `claude-*` is Anthropic, `gpt-*` is OpenAI. A `provider` column (or a provider
// field a table author could get wrong) would be a second source of truth that
// nothing forces to agree with the id, and the disagreement would surface as a
// call billed to the wrong user's key. See §9.0: this is also why the LLM setting
// needs no new config column.
// ---------------------------------------------------------------------------
export type LlmProviderId = "anthropic" | "openai";

export type LlmModelSpec = {
  id: string; // canonical id == configs.llm_model == the provider's API id
  provider: LlmProviderId; // DERIVED from `id` — see llmProviderOf
  label: string; // picker text
  contextTokens: number;
  note?: string; // picker sub-label ("cheap tier", "previous flagship")
};

// The id → provider rule, in one place. Prefix-based rather than a registry
// lookup so it also answers for ids the registry does not list: providers echo
// back resolved dated ids ("claude-haiku-4-5-20251001"), the cascade's cheap tier
// and the semantic-cache judge models are configured as bare strings, and a user
// could paste a newer id before anyone adds a row below. All of those still have
// an unambiguous provider, and dispatching them correctly is more useful than
// refusing them.
//
// Returns null rather than guessing. A wrong guess here charges one user's call
// to the other provider's key — the one failure mode strict BYOK exists to
// prevent — so an unrecognised prefix must be loud, not defaulted.
export function llmProviderFor(id: string): LlmProviderId | null {
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gpt-")) return "openai";
  return null;
}

// Same rule, for callers that cannot proceed without an answer (the meter's
// dispatch, the cascade's cheap-tier lookup). Fails loudly for the reason above.
export function llmProviderOf(id: string): LlmProviderId {
  const provider = llmProviderFor(id);
  if (!provider) {
    throw new Error(
      `Cannot tell which provider serves LLM model "${id}" — expected a "claude-" or "gpt-" prefix.`,
    );
  }
  return provider;
}

// The registry rows, WITHOUT `provider` — it is filled in below from the id, so
// the table has no way to disagree with itself.
//
// This list is CURATED, not a catalogue. Every id below is one we would defend
// picking for a config; everything else the providers still serve is one line
// away when there is a reason to offer it. Rates for each live in
// lib/rag/pricing.ts (LLM_PRICES) — kept there, not here, because pricing is the
// ledger's concern and a rate can change without the model changing.
//
// Context windows are the provider's stated input limit. For the OpenAI rows
// that is 272K, which is also the boundary above which OpenAI bills the ~2×
// long-context rate (see the LLM_PRICES comment) — our prompts are chunked RAG
// contexts of a few thousand tokens, so it is unreachable in practice.
type LlmModelRow = Omit<LlmModelSpec, "provider">;

const LLM_MODEL_ROWS: Record<string, LlmModelRow> = {
  // --- Anthropic (ids + rates from the bundled claude-api skill, 2026-08-05) --
  // Excluded deliberately: claude-fable-5 (10/50 — above the Opus tier, and it
  // requires 30-day data retention, an org setting we cannot assert from here)
  // and every -pro / retired id.
  "claude-opus-5": { id: "claude-opus-5", label: "Claude Opus 5", contextTokens: 1_000_000, note: "flagship" },
  // Same price as Opus 5, which is exactly what makes it useful: an A/B pair
  // whose cost difference is zero, so a quality difference is the only variable.
  "claude-opus-4-8": { id: "claude-opus-4-8", label: "Claude Opus 4.8", contextTokens: 1_000_000, note: "previous flagship" },
  "claude-sonnet-5": { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextTokens: 1_000_000, note: "near-Opus at Sonnet cost" },
  // Today's default (lib/config.ts). Keep it registered forever-ish: every
  // existing config row holds this id, and llmSpec() throwing on it would break
  // the picker for every config that has never been touched.
  "claude-sonnet-4-6": { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextTokens: 1_000_000, note: "default" },
  "claude-haiku-4-5": { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextTokens: 200_000, note: "cheap tier" },

  // --- OpenAI (ids + rates from developers.openai.com pricing, 2026-08-05) ----
  // Excluded: gpt-5.5, gpt-5.2, gpt-5.1, gpt-5, the -pro variants (30/180 and
  // up), and everything gpt-4* / o*. All still served — this is curation, not
  // availability.
  "gpt-5.6-sol": { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", contextTokens: 272_000, note: "flagship" },
  "gpt-5.6-terra": { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", contextTokens: 272_000, note: "mid tier" },
  "gpt-5.6-luna": { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", contextTokens: 272_000, note: "cheap tier" },
  "gpt-5.4": { id: "gpt-5.4", label: "GPT-5.4", contextTokens: 272_000, note: "previous generation" },
  "gpt-5.4-mini": { id: "gpt-5.4-mini", label: "GPT-5.4 mini", contextTokens: 272_000, note: "previous generation, mid" },
  "gpt-5.4-nano": { id: "gpt-5.4-nano", label: "GPT-5.4 nano", contextTokens: 272_000, note: "previous generation, cheap" },
};

// The registry proper: every row with its provider resolved from its id. Built
// once at module load, which also means a row whose id carries no recognisable
// prefix fails at import rather than at generation time, three screens away from
// the typo.
export const LLM_MODELS: Record<string, LlmModelSpec> = Object.fromEntries(
  Object.entries(LLM_MODEL_ROWS).map(([id, row]) => [
    id,
    { ...row, provider: llmProviderOf(id) },
  ]),
);

// Look up a model spec, failing loudly on an unknown id — the same contract as
// modelSpec() in the embedding registry, and for the same reason: a missing
// registry entry is a bug to surface, not a silent fall back to a default the
// user did not choose. This is also the validator §9.2's PATCH route uses to
// reject an unknown llm_model with a 400, so an id that cannot be generated with
// is refused at the control that sets it.
export function llmSpec(id: string): LlmModelSpec {
  const spec = LLM_MODELS[id];
  if (!spec) {
    throw new Error(`Unknown LLM model "${id}". Add it to LLM_MODELS.`);
  }
  return spec;
}

// Why a provider is unavailable, phrased as the action that would fix it.
// Separate from the embedding registry's unavailableReason() even though the
// strings rhyme: that one also answers for `local`, which is a host capability
// no user can fix, and merging the two unions would let a caller ask this
// function about a provider it has no advice for.
export function llmUnavailableReason(provider: LlmProviderId): string {
  switch (provider) {
    case "anthropic":
      return "add an Anthropic key in Settings";
    case "openai":
      return "add an OpenAI key in Settings";
  }
}

export type LlmModelOption = {
  id: string;
  label: string;
  provider: LlmProviderId;
  contextTokens: number;
  note: string | null;
  // selectable = the user holds a key for this model's provider.
  selectable: boolean;
  // Why it's NOT selectable, for the greyed-out tooltip; null when selectable.
  reason: string | null;
};

// Options for the config Settings LLM picker (§9.2), in registry order.
//
// An unkeyed provider's models are LISTED GREYED OUT with the reason, never
// dropped — the same contract as listBaseModelOptions and the autotune/aggregate
// checklists. Dropping them would make a picker that shows only Anthropic look
// like an app that only supports Anthropic, when the truth is one missing key.
//
// `availability` is the structural ProviderAvailability type from the embedding
// registry (deliberately structural, so one `await availableProviders()` answers
// for both registries — see its comment). Re-declared here rather than imported
// so this module has no dependency on the embedding side.
//
// `provider` filters to one provider's models, for the picker's Provider select,
// which is purely a filter and is not persisted (§9.2).
export function listLlmOptions(
  availability: { has(provider: string): boolean },
  provider?: LlmProviderId,
): LlmModelOption[] {
  return Object.values(LLM_MODELS)
    .filter((spec) => provider === undefined || spec.provider === provider)
    .map((spec) => {
      const available = availability.has(spec.provider);
      return {
        id: spec.id,
        label: spec.label,
        provider: spec.provider,
        contextTokens: spec.contextTokens,
        note: spec.note ?? null,
        selectable: available,
        reason: available ? null : llmUnavailableReason(spec.provider),
      };
    });
}
