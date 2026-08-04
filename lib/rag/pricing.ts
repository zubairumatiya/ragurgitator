// ---------------------------------------------------------------------------
// PRICING + LEVER REGISTRY — the single source of truth the model registry never
// had (autotuneModelLadder's comment: "no cost field exists in the registry to
// derive it from"). Everything that costs an API call reads its price here, and
// the savings ledger classifies every lever through LEVERS below.
//
// See docs/savings-accounting-plan.md. Prices are USD per 1M tokens, seeded from
// the research doc's cited figures (Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, voyage
// lite/4/large $0.02/$0.06/$0.12). An UNKNOWN model costs 0 (with a one-time
// warn) — we never fabricate a price, so a missing entry under-counts rather
// than lies. Add models here as they enter the app.
// ---------------------------------------------------------------------------

// The offline/interactive surfaces that spend money, for the gross-spend tally.
export type Surface =
  | "chat" // generator.ts — the answer model
  | "ndcg_ranking" // ranking.ts — the LLM ideal-ranking judge
  | "question_gen" // eval.ts — eval question synthesis
  | "cluster_label" // clusterLabeler.ts — bucket naming
  | "judge" // semanticCacheCalibration.ts — the shadow-judge verdict pass
  | "cache_pairs" // semanticCachePairs.ts — key-model eval pair synthesis
  | "embed"; // embedCache.ts miss — a paid embedding call

export const SURFACE_LABELS: Record<Surface, string> = {
  chat: "Chat answers",
  ndcg_ranking: "nDCG LLM ranking",
  question_gen: "Question generation",
  cluster_label: "Cluster labeling",
  judge: "Semantic-cache judge",
  cache_pairs: "Cache-key pair generation",
  embed: "Embeddings",
};

// The savings levers (docs §2). `category` drives the Realized/Structural/Naive
// view filter; `basis` flags exact (real provider usage) vs. estimate (char/4
// token counts). Naive = realized + structural, so no lever is double-viewed.
export type SavingsCategory = "realized" | "structural";
export type SavingsBasis = "exact" | "estimate";
export type LeverId =
  | "embed_cache" // #1 avoided re-embed (cache hit)
  | "cascade" // #2 FrugalGPT-lite: cheap-first, NET of escalations
  | "semantic_cache" // #3 served answer skips retrieve+generate
  | "batch" // #4 −50% Anthropic / −33% Voyage on offline jobs
  // (#5 "nDCG by bucket, not corpus" is RETIRED — the aggregate nDCG pool now
  // comes from a direct HNSW query, so there is no bucket-vs-corpus saving to
  // bank. Its historical rows are deleted by migrations/0039. The remaining ids
  // keep their doc numbers; the gap is intentional.)
  | "ingest_skip" // #9 doc already embedded under this config — embed skipped
  | "eval_embed_reuse"; // #10 calibration reads banked eval vectors — no re-embed

export const LEVERS: Record<
  LeverId,
  { label: string; category: SavingsCategory; basis: SavingsBasis }
> = {
  embed_cache: { label: "Embedding cache", category: "structural", basis: "estimate" },
  ingest_skip: { label: "Re-ingest skip (already embedded)", category: "structural", basis: "estimate" },
  eval_embed_reuse: {
    label: "Eval-embedding reuse (calibration)",
    category: "structural",
    basis: "estimate",
  },
  cascade: { label: "Saver cascade (FrugalGPT-lite)", category: "realized", basis: "exact" },
  semantic_cache: { label: "Semantic answer cache", category: "realized", basis: "estimate" },
  batch: { label: "Batch API", category: "realized", basis: "exact" },
};

// --- price tables (USD per 1M tokens) --------------------------------------

type LlmPrice = { inputPerM: number; outputPerM: number };

// Keyed on the DATE-LESS alias. Real responses may echo a resolved dated ID
// (e.g. "claude-haiku-4-5-20251001"), so lookup strips a trailing -YYYYMMDD —
// see costLlm. Add the alias here, never the dated form.
const LLM_PRICES: Record<string, LlmPrice> = {
  "claude-opus-4-8": { inputPerM: 5, outputPerM: 25 },
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15 },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5 },
};

// Embedding rates. ONE table, TWO consumers with different needs:
//
//   - costEmbed (accounting) always wants a NUMBER. An absent price silently
//     costs $0 (warnUnknown → 0), which under-counts the ledger forever.
//   - the Appraise → Models rate card (display) must never quote a figure we
//     can't stand behind.
//
// Hence `verified`: a false entry still COSTS at usdPerM, but the rate card
// renders "—" for it. Don't collapse these back into a bare number.
//
// `freeTierM` is the provider's free allowance in MILLIONS of tokens, per
// account. It's policy, not an API-readable value, so it goes stale silently —
// RATES_VERIFIED_ON dates it, and the rate card footnotes that date.
//
// Verified 2026-08-02 against provider docs: every Voyage figure and Cohere's
// were already correct. The one exception is text-embedding-3-large, where
// OpenAI's own two pages disagree — the model card says $0.13/1M, the pricing
// page says $0.065/1M, with open community reports about the discrepancy. A
// conflict between primary sources is a stronger reason to withhold a number
// than a missing one, so it's unverified until OpenAI resolves it. We keep
// costing at 0.13 (the model card) so accounting stays conservative.
export type EmbedRate = {
  usdPerM: number; // what costEmbed uses — always a number
  verified: boolean; // false ⇒ rate card shows "—"
  freeTierM: number | null; // provider free allowance, millions of tokens
};

// The as-of date for every figure below, rendered by the rate card's footnote.
export const RATES_VERIFIED_ON = "2026-08-02";

export const EMBED_RATES: Record<string, EmbedRate> = {
  // Voyage: first 200M tokens free on the voyage-4 family + code-3/code-2,
  // first 50M on finance-2/law-2 (docs.voyageai.com/docs/pricing).
  "voyage-4-lite": { usdPerM: 0.02, verified: true, freeTierM: 200 },
  "voyage-4": { usdPerM: 0.06, verified: true, freeTierM: 200 },
  "voyage-4-large": { usdPerM: 0.12, verified: true, freeTierM: 200 },
  "voyage-code-3": { usdPerM: 0.18, verified: true, freeTierM: 200 },
  "voyage-code-2": { usdPerM: 0.12, verified: true, freeTierM: 200 },
  "voyage-finance-2": { usdPerM: 0.12, verified: true, freeTierM: 50 },
  "voyage-law-2": { usdPerM: 0.12, verified: true, freeTierM: 50 },
  // OpenAI — see the note above; unverified on a source conflict, not absence.
  "text-embedding-3-large": { usdPerM: 0.13, verified: false, freeTierM: null },
  "embed-v4": { usdPerM: 0.12, verified: true, freeTierM: null }, // Cohere
  // Local models run on your own hardware: free, and trivially "verified".
  "mxbai-embed-large": { usdPerM: 0, verified: true, freeTierM: null },
  "bge-m3": { usdPerM: 0, verified: true, freeTierM: null },
};

// Provider batch-API discounts (docs §5.1): the multiple of standard cost SAVED.
export const BATCH_DISCOUNT = { anthropic: 0.5, voyage: 0.33 } as const;

const warned = new Set<string>();
function warnUnknown(kind: string, model: string): void {
  const key = `${kind}:${model}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[rag:pricing] no ${kind} price for "${model}" — costing it as $0`);
}

// Look a model up in a price table, tolerating a VERSIONED id. Providers may
// echo back a resolved dated id ("claude-haiku-4-5-20251001") where we only
// store the alias ("claude-haiku-4-5") — without this, a batch result would
// price at $0 forever and the lever would silently accrue nothing. Exact match
// first, then the longest table key that the id extends at a "-" boundary, so
// "claude-opus-4-8-20260101" can never match a shorter unrelated prefix.
function priceFor<T>(table: Record<string, T>, model: string): T | undefined {
  const exact = table[model];
  if (exact !== undefined) return exact;

  let bestKey: string | null = null;
  for (const key of Object.keys(table)) {
    if (!model.startsWith(`${key}-`)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === null ? undefined : table[bestKey];
}

// USD cost of one LLM call given token counts. Unknown model → 0 (+ one warn).
export function costLlm(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(LLM_PRICES, model);
  if (!p) {
    warnUnknown("llm", model);
    return 0;
  }
  return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
}

// USD cost of embedding `tokens` under `model`. Unknown model → 0 (+ one warn).
// Reads usdPerM regardless of `verified`: an unverified rate is still our best
// estimate of what we were billed, and dashing it here would under-count.
export function costEmbed(model: string, tokens: number): number {
  const rate = priceFor(EMBED_RATES, model);
  if (rate === undefined) {
    warnUnknown("embed", model);
    return 0;
  }
  return (tokens * rate.usdPerM) / 1_000_000;
}

// The rate for one model, tolerating a versioned id, for the rate card. Callers
// that want a displayable price must check `verified` themselves — this returns
// the accounting rate either way.
export function embedRate(model: string): EmbedRate | undefined {
  return priceFor(EMBED_RATES, model);
}

// Cheap token estimate (≈4 chars/token) — used everywhere the provider doesn't
// hand back a real count (all embeds; the semantic-cache counterfactual).
// The embed leg is cents at this corpus size, so char/4 is plenty; the LLM leg
// uses real `usage` wherever it can (see meter.ts / generator.ts).
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

// Same estimate, for callers that have a character COUNT but not the text —
// the re-ingest skip prices a run it never loads (`select sum(length(text))`),
// so the 4-chars-per-token constant stays in exactly one place.
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

export function estimateTokensAll(texts: string[]): number {
  let n = 0;
  for (const t of texts) n += estimateTokens(t);
  return n;
}
