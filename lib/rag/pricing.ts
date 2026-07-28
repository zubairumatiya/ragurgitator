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

// Embedding $/M tokens. Voyage from its pricing page; local models are free but
// still listed (0) so they don't trip the unknown-model warn. Values marked
// "~confirm" are best-effort and should be verified against current provider
// pricing before any figure is quoted externally.
const EMBED_PRICES: Record<string, number> = {
  "voyage-4-lite": 0.02,
  "voyage-4": 0.06,
  "voyage-4-large": 0.12,
  "voyage-code-3": 0.18, // ~confirm
  "voyage-code-2": 0.12, // ~confirm
  "voyage-finance-2": 0.12, // ~confirm
  "voyage-law-2": 0.12, // ~confirm
  "text-embedding-3-large": 0.13, // OpenAI ~confirm
  "embed-v4": 0.12, // Cohere ~confirm
  "mxbai-embed-large": 0, // local
  "bge-m3": 0, // local
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
export function costEmbed(model: string, tokens: number): number {
  const perM = priceFor(EMBED_PRICES, model);
  if (perM === undefined) {
    warnUnknown("embed", model);
    return 0;
  }
  return (tokens * perM) / 1_000_000;
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
