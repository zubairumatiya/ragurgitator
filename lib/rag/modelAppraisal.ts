// ---------------------------------------------------------------------------
// DB + registry layer for Appraise → Models (docs/appraise-model-comparison-plan.md).
//
// What's left here after the replay took over the quality half (§2):
//
//   1. listModelRateCard()  — pure registry + price table + env availability.
//      No DB. Always fully populated, which is why the Models tab is useful on
//      first open even with zero eval data.
//   2. meteredEmbedTokens() — the one number behind the rate card's free-tier
//      note.
//
// The per-model quality comparison lives in lib/rag/replayStore.
//
// EMBEDDING MODELS ONLY. The Anthropic answer/judge models are priced in
// pricing.ts too, but nothing measures their quality, so they'd be a table of
// prices with every metric dashed — they belong on the Costs tab, not here.
// ---------------------------------------------------------------------------
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import {
  EMBEDDING_MODELS,
  unavailableReason,
  type EmbeddingProviderId,
  type ProviderAvailability,
} from "@/lib/rag/embeddingModels";
import {
  LLM_MODELS,
  llmUnavailableReason,
  type LlmProviderId,
} from "@/lib/llm/llmModels";
import { embedRate, llmRate } from "@/lib/rag/pricing";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// --- 1. the rate card -------------------------------------------------------

export type RateCardRow = {
  id: string;
  provider: EmbeddingProviderId;
  dimension: number;
  // null ⇒ render "—". Either the model has no rate at all, or its rate is
  // unverified (today: text-embedding-3-large, where OpenAI's model card and
  // pricing page disagree). costEmbed still charges the underlying number —
  // see EmbedRate.verified in pricing.ts.
  usdPerM: number | null;
  freeTierM: number | null; // provider free allowance, millions of tokens
  available: boolean; // provider credential/weights present right now
  ingestable: boolean; // can be a config's base_model (has a chunks_* table)
  // Why it can't be used as a base model today; null when it can.
  reason: string | null;
};

// Every registered model with price + availability. Takes the resolved
// availability set (see lib/rag/providerAvailability.ts) — under BYOK
// "available" is a per-user fact, so the card renders differently per viewer.
//
// Unlike listBaseModelOptions this does NOT filter to ingestion candidates: the
// alternate Voyage entries are exactly what the comparison table scores, so a
// rate card that hid them would price the models you can't try and omit the
// ones you can.
export function listModelRateCard(availability: ProviderAvailability): RateCardRow[] {
  return Object.values(EMBEDDING_MODELS).map((spec) => {
    const rate = embedRate(spec.id);
    const available = availability.has(spec.provider);
    const reasons: string[] = [];
    if (!available) reasons.push(unavailableReason(spec.provider));
    if (!spec.ingestable) reasons.push("no vector table yet");
    return {
      id: spec.id,
      provider: spec.provider,
      dimension: spec.dimension,
      usdPerM: rate && rate.verified ? rate.usdPerM : null,
      freeTierM: rate?.freeTierM ?? null,
      available,
      ingestable: spec.ingestable,
      reason: reasons.length > 0 ? reasons.join("; ") : null,
    };
  });
}

// --- 1b. the LLM rate card ---------------------------------------------------
//
// The generation side of the same question. Until now LLM_PRICES was priced in
// the ledger but never SHOWN anywhere — you could see what a model had cost you
// after the fact on Costs, but not what it would cost before you picked it.
// With §9.2's picker offering eleven models across two providers, that gap is
// the difference between an informed choice and a guess.
//
// Deliberately NOT merged with RateCardRow. An embedding model is priced on one
// axis (per input token) and an LLM on two (input and output, at very different
// rates), and it has no dimension while an LLM has a context window. A union row
// would be half-null in both directions.

export type LlmRateCardRow = {
  id: string;
  label: string;
  provider: LlmProviderId;
  contextTokens: number;
  // Both null ⇒ render "—". Unlike the embedding card there is no `verified`
  // flag to strip a rate (see llmRate); null here means the model is registered
  // in llmModels but genuinely missing from LLM_PRICES, which is a bug worth
  // seeing rather than hiding behind a plausible number.
  inputPerM: number | null;
  outputPerM: number | null;
  note: string | null;
  available: boolean; // the viewer holds a key for this provider
  reason: string | null; // why not; null when available
};

// Every registered LLM with price + per-user availability, sorted ASCENDING BY
// OUTPUT RATE. Output is the column that ranks the ladder honestly: at this
// app's prompt sizes (a few thousand tokens of chunked context in, a short
// answer out) generation spend is dominated by the output rate, so sorting on
// input would put the cheap-to-prompt/expensive-to-answer models at the top and
// misrepresent which one is actually cheap to run here.
//
// Ties break on input rate, then id, so the order is stable across renders
// rather than depending on registry insertion order for the several models that
// share an output rate.
export function listLlmRateCard(availability: ProviderAvailability): LlmRateCardRow[] {
  return Object.values(LLM_MODELS)
    .map((spec) => {
      const rate = llmRate(spec.id);
      const available = availability.has(spec.provider);
      return {
        id: spec.id,
        label: spec.label,
        provider: spec.provider,
        contextTokens: spec.contextTokens,
        inputPerM: rate?.inputPerM ?? null,
        outputPerM: rate?.outputPerM ?? null,
        note: spec.note ?? null,
        available,
        reason: available ? null : llmUnavailableReason(spec.provider),
      };
    })
    .sort(
      (a, b) =>
        (a.outputPerM ?? Infinity) - (b.outputPerM ?? Infinity) ||
        (a.inputPerM ?? Infinity) - (b.inputPerM ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
}

// --- 2. performance: moved ---
//
// This module used to compute a per-model comparison from eval_runs and
// eval_model_trials. The trial half could not work: a trial re-ranks inside a
// candidate pool that contains the correct chunk by construction, so every
// model scored 1.000 and nothing was comparable. It was replaced by the offline
// replay (lib/rag/replayStore, migration 0043), which ranks the FULL corpus for
// each model from vectors already in embedding_cache — same questions, same
// scan, only the model changes — and measures a real spread.
//
// The full-corpus eval_runs snapshots still power /appraise/configs via
// appraiseStore.listConfigComparisons; the Models tab reads them only for the
// live-vs-replay note under each table.

// --- 3. the free-tier line --------------------------------------------------

// Embed tokens this app has METERED (spend_totals, surface='embed'), for the
// rate card's free-tier note.
//
// Deliberately narrow, and the UI copy must match: this is what THIS APP has
// recorded since cost accounting shipped (0034). It is not per-model, and it is
// not the provider's free-tier counter — Voyage's allowance is per ACCOUNT and
// covers every other use of that key, which we can't see. Never render this as
// a "% of free tier used" bar; the denominators don't line up.
//
// Best-effort like the rest of savingsStore: no 0034 tables → 0.
export async function meteredEmbedTokens(configId?: string | null): Promise<number> {
  const owned = sql`config_id in (select id from configs where user_id = ${activeUserId()})`;
  const scope = configId
    ? sql`where surface = 'embed' and config_id = ${configId} and ${owned}`
    : sql`where surface = 'embed' and ${owned}`;
  try {
    const [row] = await sql<{ tokens: string | null }[]>`
      select sum(tokens) as tokens from spend_totals ${scope}
    `;
    return Number(row?.tokens ?? 0);
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
