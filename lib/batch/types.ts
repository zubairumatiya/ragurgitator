// ---------------------------------------------------------------------------
// BATCH API — shared vocabulary (Phase E1, docs/batch-api-savings-plan.md).
//
// One place for the enums/types every batch module agrees on: the four offline
// JOB KINDS, the two provider LEGS the Settings dropdown groups them into, the
// per-config SAVINGS preference + its effective-choice resolver, and the
// normalized job STATUS lifecycle. No I/O here — pure types + tiny helpers, so
// it imports nothing and can be used from server code and (via structural
// types) client code alike.
// ---------------------------------------------------------------------------

// Which batch API a job is submitted to. NOT a per-kind fact: the two LLM
// providers both serve a batch API, and which one a job goes to follows from the
// MODEL its requests carry (docs/user-accounts-plan.md §9.1 — provider is derived
// from the model id, never stored twice). That is why there is no
// `providerOfKind(kind)` here any more: only the job's build() knows which model
// it put in the requests, so build() names the provider — see BuiltBatch.provider
// in lib/batch/jobs/registry.ts.
export type BatchProvider = "anthropic" | "openai" | "voyage";

// The offline surfaces that may run through a batch API (chat answers and live
// query embeds are excluded by design — they're interactive; see the plan doc).
export const JOB_KINDS = [
  "question_generation",
  "ndcg_ranking",
  "cluster_labeling",
  "ingest_embedding",
  "cache_pair_generation",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_LABELS: Record<JobKind, string> = {
  question_generation: "Question generation",
  ndcg_ranking: "nDCG LLM ranking",
  cluster_labeling: "Cluster labeling",
  ingest_embedding: "Ingest / re-embedding",
  cache_pair_generation: "Cache-key eval pairs",
};

// The two "settings" the user groups jobs into: the embedding leg is just
// ingest_embedding; the LLM leg is everything else. Deliberately still a
// per-KIND fact even though the provider is not — the Settings dropdown groups
// by "embedding vs answer generation", which stays true whichever vendor serves
// either leg.
export type BatchLeg = "embedding" | "llm";
export function legOfKind(kind: JobKind): BatchLeg {
  return kind === "ingest_embedding" ? "embedding" : "llm";
}

// --- the per-config preference (configs.batch_savings) ---------------------

export type BatchChoice = "standard" | "batch";

export type BatchSavings = {
  // One choice per job, full stop. There are only four, so grouping them behind
  // per-leg settings (which earlier versions did, see coerceBatchSavings) bought
  // nothing but a layer to reason through.
  jobs: Record<JobKind, BatchChoice>;
  // Semantic answer cache (docs/semantic-caching-plan.md): serve a stored answer
  // for a near-duplicate question, skipping retrieval/generation. Note this only
  // governs whether a HIT is SERVED — the cache is always populated regardless,
  // so turning `serve` on later has data to hit against. Opt-in (default off): a
  // served hit can be wrong if the proximity threshold is loose.
  //
  // `threshold` is this config's OVERRIDE of the cosine floor a match must clear
  // to be served. null = inherit, which is the norm: the calibrated per-space
  // value (semantic_cache_thresholds) if there is one, else the conservative
  // config.semanticCache.defaultThreshold. Set it when one config wants to run
  // looser or tighter than its space-mates — the space table is keyed by
  // VECTOR-SPACE, so it's shared by every config on the same embedding model and
  // can't express that. Resolution order lives in semanticCache.resolveThreshold.
  //
  // `keyModel` is this config's OVERRIDE of the CACHE-KEY embedding model — the
  // model incoming questions are embedded under for the proximity match, which
  // is decoupled from the config's retrieval model (see config.semanticCache.
  // keyModel and docs/semantic-cache-key-model-plan.md, Phase 1). null =
  // inherit the global default, which is the norm. Resolution order lives in
  // semanticCache.resolveKeyModel.
  //
  // `acceptTarget` is this config's OVERRIDE of the PRECISION the calibration
  // sweeps hold themselves to — P(accept | sim ≥ τ) — not a cosine. null =
  // inherit config.semanticCache.acceptTarget (0.99). It is the safety dial:
  // raising it picks a stricter τ that serves less, lowering it serves more and
  // admits more wrong answers. Separate from `threshold` on purpose — that one
  // sets τ by hand, this one sets the RULE that derives τ from judged evidence.
  //
  // Worth knowing before turning it down: the target is only reachable at all
  // when the served prefix is big enough for it. Clearing 0.99 with r rejects
  // in the prefix needs n ≥ 100r, so on a small judged set 0.99 means "zero
  // false positives" and no τ is recommended at all. calibrateFromJudged
  // reports that as an attainability blocker rather than a bare null — see
  // semanticCacheCore.
  semanticCache: {
    serve: boolean;
    threshold: number | null;
    keyModel: string | null;
    acceptTarget: number | null;
  };
};

export const DEFAULT_BATCH_SAVINGS: BatchSavings = {
  jobs: {
    question_generation: "standard",
    ndcg_ranking: "standard",
    cluster_labeling: "standard",
    ingest_embedding: "standard",
    cache_pair_generation: "standard",
  },
  semanticCache: { serve: false, threshold: null, keyModel: null, acceptTarget: null },
};

// The effective choice for a kind. This is THE resolver every launch point calls
// to decide "submit a batch or run inline?" — now a plain lookup, but kept as a
// function so launch points don't have to care that it stopped being one.
export function effectiveChoice(pref: BatchSavings, kind: JobKind): BatchChoice {
  return pref.jobs[kind];
}
export function isBatchEnabled(pref: BatchSavings, kind: JobKind): boolean {
  return effectiveChoice(pref, kind) === "batch";
}

// Older persisted shapes this still has to read. Both grouped jobs under two
// per-leg settings; see the migration note on coerceBatchSavings.
type LegacyBatchSavings = {
  mode?: unknown; // 'bulk' | 'individual' in the oldest shape, absent after
  bulk?: Partial<Record<BatchLeg, unknown>>;
  jobs?: Partial<Record<JobKind, unknown>>;
  semanticCache?: {
    serve?: unknown;
    threshold?: unknown;
    keyModel?: unknown;
    acceptTarget?: unknown;
  };
};

// Tolerant coercion of an unknown jsonb blob (or a partial patch) into a full
// preference — missing/invalid fields fall back to the default. Used on read
// (old rows, hand-edited jsonb) and on patch-merge in the store.
//
// Also MIGRATES the two shapes that predate the flat per-job map. There is no
// SQL migration: old rows keep their jsonb until something saves over them, and
// this converts on every read, preserving each job's EFFECTIVE choice.
//
//   1. `{ mode, bulk, jobs }` — `mode` picked WHICH map to read, leaving the
//      other one dead. Under mode:'bulk' the jobs map holds stale values that
//      were never in force, so it must be ignored rather than merged.
//   2. `{ bulk, jobs }` with nullable jobs — legs as a base, jobs as an
//      override layer on top (null = inherit). Resolved by `jobs[k] ?? leg`.
//
// Both collapse to: mode:'bulk' → the leg wins outright; otherwise the job's own
// value wins when it has one, else its leg.
// A per-config threshold override is only honoured when it's a real cosine in
// [0,1]. Anything else — absent (every row predating this field), null, a string
// from a hand-edited blob, NaN — means INHERIT, which is also the safe outcome:
// the space calibration or the conservative default takes over rather than an
// unusable number reaching the serving gate.
function coerceThreshold(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

// Same tri-state shape for the cache-key model override: anything that isn't a
// non-empty string means INHERIT the global default. Whether the string names a
// REGISTERED model isn't decided here — this file is deliberately import-free
// (it's read from client code too) and the registry lives server-side. The
// write path validates the id (app/api/batch), and semanticCache.resolveKeyModel
// falls back to the global default on an unknown one, so a hand-edited blob
// degrades to the default rather than to a provider error on the hot path.
function coerceKeyModel(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// A precision-target override is only honoured inside [0.5, 1]. The upper bound
// is definitional (a probability), but the LOWER bound is a judgement: below 0.5
// the sweep would be told "most of what you serve may be wrong is acceptable",
// which no caller means, and the value reaching the sweep silently would collapse
// τ toward serving everything. Out of band — like every other invalid value here
// — means INHERIT, so the global 0.99 takes over rather than an unusable number
// deciding what gets served.
//
// 1 IS allowed and is not the same as "unset": it demands a perfectly clean
// served prefix, which is attainable (and is what a tiny judged set effectively
// enforces anyway) — it just makes requiredN meaningless, which
// calibrateFromJudged handles explicitly.
function coerceAcceptTarget(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 1 ? v : null;
}

export function coerceBatchSavings(raw: unknown): BatchSavings {
  const r = (raw ?? {}) as LegacyBatchSavings;
  const choice = (v: unknown): BatchChoice | null =>
    v === "batch" || v === "standard" ? v : null;
  const d = DEFAULT_BATCH_SAVINGS;
  const legWins = r.mode === "bulk";

  const resolve = (kind: JobKind): BatchChoice => {
    const own = legWins ? null : choice(r.jobs?.[kind]);
    return own ?? choice(r.bulk?.[legOfKind(kind)]) ?? d.jobs[kind];
  };

  return {
    jobs: {
      question_generation: resolve("question_generation"),
      ndcg_ranking: resolve("ndcg_ranking"),
      cluster_labeling: resolve("cluster_labeling"),
      ingest_embedding: resolve("ingest_embedding"),
      cache_pair_generation: resolve("cache_pair_generation"),
    },
    // Absent (old rows) or non-boolean → the safe default (don't serve).
    semanticCache: {
      serve: r.semanticCache?.serve === true,
      threshold: coerceThreshold(r.semanticCache?.threshold),
      keyModel: coerceKeyModel(r.semanticCache?.keyModel),
      acceptTarget: coerceAcceptTarget(r.semanticCache?.acceptTarget),
    },
  };
}

// --- job lifecycle ---------------------------------------------------------

// Our normalized status. Provider statuses are mapped into these in providers.ts:
//   submitting  — row created, provider create() not yet returned
//   in_progress — provider is processing
//   completed   — provider done, results fetchable, NOT yet written back
//   applied     — results written into the app's tables (terminal, success)
//   failed      — submit failed, or provider/apply errored (terminal)
//   cancelling  — user requested cancel, provider winding down
//   cancelled   — cancel finished (terminal)
//   expired     — provider dropped the batch past its window (terminal)
export const BATCH_STATUSES = [
  "submitting",
  "in_progress",
  "completed",
  "applied",
  "failed",
  "cancelling",
  "cancelled",
  "expired",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const TERMINAL_STATUSES: readonly BatchStatus[] = [
  "applied",
  "failed",
  "cancelled",
  "expired",
];
export function isTerminal(status: BatchStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
// Non-terminal AND not the transient submitting state = worth polling a provider for.
export function isPollable(status: BatchStatus): boolean {
  return status === "in_progress" || status === "completed" || status === "cancelling";
}
// `in_progress` ONLY, and `submitting` is the interesting exclusion: cancelling
// means telling the PROVIDER to stop, and a submitting row has no
// provider_batch_id to name — cancelJob refuses it for exactly that reason. This
// predicate gates the panel's Cancel button, so including submitting rendered a
// button whose click did nothing at all: no provider call, no status change, no
// error. A stranded submit's exit is failStaleSubmittingJobs (lib/rag/batchStore),
// not a cancel it cannot perform.
export function isCancelable(status: BatchStatus): boolean {
  return status === "in_progress";
}

// --- provider I/O shapes ---------------------------------------------------

// One request to submit. `params` is an Anthropic MessageCreateParams for both
// LLM providers (the OpenAI adapter translates it per JSONL line — see
// lib/llm/openaiChat.ts) or a Voyage embeddings body; the adapter shapes it.
//
// `customId` MUST match Anthropic's ^[a-zA-Z0-9_-]{1,64}$ — build it with
// batchCustomId() below rather than by hand.
export type BatchRequest = { customId: string; params: unknown };

// Join parts into a provider-safe custom id.
//
// ANTHROPIC ENFORCES ^[a-zA-Z0-9_-]{1,64}$ AND REJECTS THE WHOLE BATCH when one
// id fails it — a 400 at submit naming only `requests.0.custom_id`, which says
// nothing about which builder produced it. `:` is the separator that reads
// naturally and is not in that set; OpenAI accepts it, so the same id shape
// works on one LLM leg and fails on the other, and nothing catches it until a
// real submit. Underscore is safe, and uuids (hex + `-`) already are.
//
// Length is the other half: 64 characters is two uuids and little else. Every
// current caller is one index + one uuid + a short discriminator (~48).
export function batchCustomId(...parts: (string | number)[]): string {
  return parts.join("_");
}

// A normalized result row, provider-agnostic. `body` is an Anthropic Message —
// including on the OpenAI leg, whose ChatCompletion bodies are translated back
// into that shape by the adapter, which is what lets every apply() handler read
// `body.content[0].text` without knowing who served it — or the Voyage embedding
// output; null on a non-success outcome.
export type BatchResultRow = {
  customId: string;
  outcome: "succeeded" | "errored" | "cancelled" | "expired";
  body: unknown | null;
  error?: string;
};

// The count/status snapshot a provider poll returns.
export type ProviderStatus = {
  status: BatchStatus;
  requestCount: number;
  succeededCount: number;
  erroredCount: number;
  // Voyage and OpenAI expose the results file id on the batch object; Anthropic
  // streams results from a dedicated endpoint and leaves this null.
  outputFileId: string | null;
};

// The full persisted job (mirrors the batch_jobs row, camelCased).
export type BatchJob = {
  id: string;
  provider: BatchProvider;
  providerBatchId: string | null;
  kind: JobKind;
  configId: string | null;
  configLabel: string;
  status: BatchStatus;
  requestCount: number;
  succeededCount: number;
  erroredCount: number;
  appliedCount: number;
  input: unknown;
  providerOutputFileId: string | null;
  error: string | null;
  acknowledged: boolean;
  emailSent: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  appliedAt: string | null;
};
