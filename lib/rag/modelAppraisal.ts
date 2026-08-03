// ---------------------------------------------------------------------------
// DB + registry layer for Appraise → Models (docs/appraise-model-comparison-plan.md).
//
// Two independent reads, deliberately not merged into one query:
//
//   1. listModelRateCard()   — pure registry + price table + env availability.
//      No DB. Always fully populated, which is why the Models tab is useful on
//      first open even with zero eval data.
//   2. listModelPerformance() — what each EMBEDDING model has actually scored
//      here, from two sources with very different trustworthiness (see below).
//
// EMBEDDING MODELS ONLY. The Anthropic answer/judge models are priced in
// pricing.ts too, but nothing measures their quality, so they'd be a table of
// prices with every metric dashed — they belong on the Costs tab, not here.
// ---------------------------------------------------------------------------
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

// --- 2. performance ---------------------------------------------------------

// How trustworthy a row's numbers are — the badge on the table.
//   "full" — eval_runs: recall over the WHOLE corpus. The real thing.
//   "pool" — eval_model_trials: recall within the trial's candidate pool, which
//            contains the correct chunk by construction (0006's header: "It is
//            NOT a live score"). Runs near 100% and cannot rank models.
//   "none" — the model has trials, but none that isolate it (all size+model).
//            Listed with dashes so the gap is visible; see plan §3.5.
export type EvidenceScope = "full" | "pool" | "none";

export type ModelPerformanceRow = {
  model: string;
  scope: EvidenceScope;
  recall: number | null; // hit_count / question_count — the shared metric
  mrr: number | null; // full-corpus only
  ndcg: number | null; // full-corpus only
  // Paired trial-vs-baseline hit delta over the same questions and pool. The
  // one defensible number in the trial data. Null on full-corpus rows.
  baselineDelta: number | null;
  questions: number;
  trials: number | null; // pool rows
  chunks: number | null; // pool rows
  configs: number | null; // full-corpus rows
  lastAt: number | null;
  usdPerM: number | null; // from the rate card, so cost sits beside quality
};

// One row per (model, evidence source). A model with BOTH kinds of evidence
// gets two rows on purpose: a corpus-scoped recall and a pool-scoped one are
// not the same measurement, and averaging them would produce a number that
// describes neither.
//
// `configId` scopes both sources to a single config, for the ?configId= picker
// the Costs tab already uses. Trials reach a config through
// document_embeddings.config_id. Omitted/null = account-wide.
export async function listModelPerformance(
  configId?: string | null,
): Promise<ModelPerformanceRow[]> {
  const [full, pool] = await Promise.all([
    fullCorpusRows(configId),
    trialRows(configId),
  ]);

  // An unscored ("none") row earns its place only when the model has NOTHING
  // else to show. voyage-4-lite is the case that forces this: it has a real
  // full-corpus row AND 134 trials that are all kind='size', so without this it
  // appears twice — once with numbers, once as a row of dashes, which reads as a
  // rendering bug rather than as "these trials varied chunking, not the model".
  const scored = new Set(
    [...full, ...pool].filter((r) => r.scope !== "none").map((r) => r.model),
  );
  const rows = [...full, ...pool].filter(
    (r) => r.scope !== "none" || !scored.has(r.model),
  );

  // Attach price so the table can sit cost beside quality without a second pass.
  for (const row of rows) {
    const rate = embedRate(row.model);
    row.usdPerM = rate && rate.verified ? rate.usdPerM : null;
  }

  // Recall desc, then QUESTIONS desc. The tiebreak is load-bearing, not
  // cosmetic: pool rows currently all sit at 1.000 (the in-pool ceiling), so
  // question count is what actually orders them — the model you've tested most
  // ranks highest, rather than one that won 2/2 by luck. Unscored rows have a
  // null recall and sort last.
  return rows.sort((a, b) => {
    if (a.recall === null && b.recall === null) return a.model.localeCompare(b.model);
    if (a.recall === null) return 1;
    if (b.recall === null) return -1;
    if (b.recall !== a.recall) return b.recall - a.recall;
    if (b.questions !== a.questions) return b.questions - a.questions;
    return a.model.localeCompare(b.model);
  });
}

// Full-corpus rows: each config's LATEST frozen eval run, grouped by the model
// that config indexes under. Same snapshots /appraise/configs reads, so the two
// tabs can never disagree.
//
// Recall is POOLED (total hits / total questions), not an average of per-config
// ratios, so a 200-question config isn't outweighed by a 5-question one. MRR and
// nDCG are question-weighted for the same reason, and skip configs where the
// metric is null rather than treating it as zero.
async function fullCorpusRows(configId?: string | null): Promise<ModelPerformanceRow[]> {
  const scope = configId ? sql`where c.id = ${configId}` : sql``;
  const rows = await sql<
    {
      model: string;
      configs: string;
      hits: string | null;
      questions: string | null;
      mrr: string | null;
      ndcg: string | null;
      last_at: Date | null;
    }[]
  >`
    select
      c.base_model                          as model,
      count(*)                              as configs,
      sum(r.hit_count)                      as hits,
      sum(r.question_count)                 as questions,
      sum(r.mrr  * r.question_count) filter (where r.mrr  is not null)
        / nullif(sum(r.question_count) filter (where r.mrr  is not null), 0)  as mrr,
      sum(r.ndcg * r.question_count) filter (where r.ndcg is not null)
        / nullif(sum(r.question_count) filter (where r.ndcg is not null), 0)  as ndcg,
      max(r.created_at)                     as last_at
    from configs c
    join lateral (
      select hit_count, question_count, mrr, ndcg, created_at
      from eval_runs er
      where er.config_id = c.id
      order by er.created_at desc
      limit 1
    ) r on true
    ${scope}
    group by c.base_model
  `;

  return rows.map((r) => {
    const questions = Number(r.questions ?? 0);
    const hits = Number(r.hits ?? 0);
    return {
      model: r.model,
      scope: "full" as const,
      recall: questions > 0 ? hits / questions : null,
      mrr: r.mrr === null ? null : Number(r.mrr),
      ndcg: r.ndcg === null ? null : Number(r.ndcg),
      baselineDelta: null,
      questions,
      trials: null,
      chunks: null,
      configs: Number(r.configs),
      lastAt: r.last_at ? r.last_at.getTime() : null,
      usdPerM: null, // filled by the caller
    };
  });
}

// Trial rows, from the per-chunk "try a different model" experiment.
//
// ONLY kind='model' rows carry numbers. 0018 added 'size' (re-chunking, no model
// varied) and 'size+model' (both varied, so a delta can't be attributed to the
// model) — including either would silently mix a chunking result into a model
// comparison. Today that filter keeps 12 of 135 rows, which looks like a bug
// until you know why, hence this comment.
//
// A model whose trials are ALL excluded still gets a row, with every metric
// null (scope "none"): dropping it makes an experiment you ran look like one you
// didn't. Today that's voyage-code-2, whose 8 trials are all size+model.
async function trialRows(configId?: string | null): Promise<ModelPerformanceRow[]> {
  const scope = configId ? sql`where de.config_id = ${configId}` : sql``;
  const rows = await sql<
    {
      model: string;
      trials: string;
      chunks: string;
      questions: string | null;
      hits: string | null;
      base_hits: string | null;
      last_at: Date | null;
    }[]
  >`
    select
      t.trial_model                                                        as model,
      count(*)                       filter (where t.kind = 'model')       as trials,
      count(distinct t.source_chunk_id) filter (where t.kind = 'model')    as chunks,
      sum(t.question_count)          filter (where t.kind = 'model')       as questions,
      sum(t.hit_count)               filter (where t.kind = 'model')       as hits,
      sum(t.stored_hit_count)        filter (where t.kind = 'model')       as base_hits,
      max(t.created_at)              filter (where t.kind = 'model')       as last_at
    from eval_model_trials t
    join document_embeddings de on de.id = t.document_embedding_id
    ${scope}
    group by t.trial_model
  `;

  return rows.map((r) => {
    const trials = Number(r.trials);
    const questions = Number(r.questions ?? 0);
    const hits = Number(r.hits ?? 0);
    const baseHits = Number(r.base_hits ?? 0);
    const scored = trials > 0 && questions > 0;
    return {
      model: r.model,
      scope: scored ? ("pool" as const) : ("none" as const),
      recall: scored ? hits / questions : null,
      mrr: null, // pool-scoped ranks would read like corpus ones — don't fake it
      ndcg: null,
      baselineDelta: scored ? hits - baseHits : null,
      questions,
      trials,
      chunks: Number(r.chunks),
      configs: null,
      lastAt: r.last_at ? r.last_at.getTime() : null,
      usdPerM: null, // filled by the caller
    };
  });
}

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
  const scope = configId
    ? sql`where surface = 'embed' and config_id = ${configId}`
    : sql`where surface = 'embed'`;
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
