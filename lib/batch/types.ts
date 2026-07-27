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

export type BatchProvider = "anthropic" | "voyage";

// The offline surfaces that may run through a batch API (chat answers and live
// query embeds are excluded by design — they're interactive; see the plan doc).
export const JOB_KINDS = [
  "question_generation",
  "ndcg_ranking",
  "cluster_labeling",
  "ingest_embedding",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_LABELS: Record<JobKind, string> = {
  question_generation: "Question generation",
  ndcg_ranking: "nDCG LLM ranking",
  cluster_labeling: "Cluster labeling",
  ingest_embedding: "Ingest / re-embedding",
};

// The two "settings" the user groups jobs into: the embedding leg (Voyage) is
// just ingest_embedding; the LLM leg (Anthropic) is the three Sonnet jobs.
export type BatchLeg = "embedding" | "llm";
export function legOfKind(kind: JobKind): BatchLeg {
  return kind === "ingest_embedding" ? "embedding" : "llm";
}
export function providerOfKind(kind: JobKind): BatchProvider {
  return kind === "ingest_embedding" ? "voyage" : "anthropic";
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
  semanticCache: { serve: boolean; threshold: number | null };
};

export const DEFAULT_BATCH_SAVINGS: BatchSavings = {
  jobs: {
    question_generation: "standard",
    ndcg_ranking: "standard",
    cluster_labeling: "standard",
    ingest_embedding: "standard",
  },
  semanticCache: { serve: false, threshold: null },
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
  semanticCache?: { serve?: unknown; threshold?: unknown };
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
    },
    // Absent (old rows) or non-boolean → the safe default (don't serve).
    semanticCache: {
      serve: r.semanticCache?.serve === true,
      threshold: coerceThreshold(r.semanticCache?.threshold),
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
//   canceling   — user requested cancel, provider winding down
//   canceled    — cancel finished (terminal)
//   expired     — provider dropped the batch past its window (terminal)
export const BATCH_STATUSES = [
  "submitting",
  "in_progress",
  "completed",
  "applied",
  "failed",
  "canceling",
  "canceled",
  "expired",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const TERMINAL_STATUSES: readonly BatchStatus[] = [
  "applied",
  "failed",
  "canceled",
  "expired",
];
export function isTerminal(status: BatchStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
// Non-terminal AND not the transient submitting state = worth polling a provider for.
export function isPollable(status: BatchStatus): boolean {
  return status === "in_progress" || status === "completed" || status === "canceling";
}
export function isCancelable(status: BatchStatus): boolean {
  return status === "in_progress" || status === "submitting";
}

// --- provider I/O shapes ---------------------------------------------------

// One request to submit. `params` is provider-specific (Anthropic
// MessageCreateParams; Voyage embeddings body); the provider adapter shapes it.
export type BatchRequest = { customId: string; params: unknown };

// A normalized result row, provider-agnostic. `body` is the Anthropic Message
// or the Voyage embedding output; null on a non-success outcome.
export type BatchResultRow = {
  customId: string;
  outcome: "succeeded" | "errored" | "canceled" | "expired";
  body: unknown | null;
  error?: string;
};

// The count/status snapshot a provider poll returns.
export type ProviderStatus = {
  status: BatchStatus;
  requestCount: number;
  succeededCount: number;
  erroredCount: number;
  // Voyage exposes the results file id on the batch object; Anthropic streams
  // results from a dedicated endpoint and leaves this null.
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
