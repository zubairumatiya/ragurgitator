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
  isProviderAvailable,
  providerKeyEnv,
  type EmbeddingProviderId,
} from "@/lib/rag/embeddingModels";
import { embedRate } from "@/lib/rag/pricing";

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

// Every registered model with price + availability. Server-only
// (isProviderAvailable reads process.env). Sync — there's no IO here.
//
// Unlike listBaseModelOptions this does NOT filter to ingestion candidates: the
// alternate Voyage entries are exactly what the comparison table scores, so a
// rate card that hid them would price the models you can't try and omit the
// ones you can.
export function listModelRateCard(): RateCardRow[] {
  return Object.values(EMBEDDING_MODELS).map((spec) => {
    const rate = embedRate(spec.id);
    const available = isProviderAvailable(spec.provider);
    const reasons: string[] = [];
    if (!available) reasons.push(`set ${providerKeyEnv(spec.provider)} to enable`);
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
