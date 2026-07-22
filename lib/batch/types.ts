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
export type BatchMode = "bulk" | "individual";

export type BatchSavings = {
  mode: BatchMode;
  // Bulk mode: one choice per leg, applied to every job in that leg.
  bulk: Record<BatchLeg, BatchChoice>;
  // Individual mode: one choice per job. Both maps persist so flipping the mode
  // dropdown never discards the other view's values.
  jobs: Record<JobKind, BatchChoice>;
  // Semantic answer cache (docs/semantic-caching-plan.md): serve a stored answer
  // for a near-duplicate question, skipping retrieval/generation. Note this only
  // governs whether a HIT is SERVED — the cache is always populated regardless,
  // so turning `serve` on later has data to hit against. Opt-in (default off): a
  // served hit can be wrong if the proximity threshold is loose.
  semanticCache: { serve: boolean };
};

export const DEFAULT_BATCH_SAVINGS: BatchSavings = {
  mode: "bulk",
  bulk: { embedding: "standard", llm: "standard" },
  jobs: {
    question_generation: "standard",
    ndcg_ranking: "standard",
    cluster_labeling: "standard",
    ingest_embedding: "standard",
  },
  semanticCache: { serve: false },
};

// The effective choice for a kind: individual mode reads the per-job value;
// bulk mode reads the kind's leg. This is THE resolver every launch point calls
// to decide "submit a batch or run inline?".
export function effectiveChoice(pref: BatchSavings, kind: JobKind): BatchChoice {
  return pref.mode === "individual" ? pref.jobs[kind] : pref.bulk[legOfKind(kind)];
}
export function isBatchEnabled(pref: BatchSavings, kind: JobKind): boolean {
  return effectiveChoice(pref, kind) === "batch";
}

// Tolerant coercion of an unknown jsonb blob (or a partial patch) into a full
// preference — missing/invalid fields fall back to the default. Used on read
// (old rows, hand-edited jsonb) and on patch-merge in the store.
export function coerceBatchSavings(raw: unknown): BatchSavings {
  const r = (raw ?? {}) as Partial<BatchSavings>;
  const choice = (v: unknown, fb: BatchChoice): BatchChoice =>
    v === "batch" || v === "standard" ? v : fb;
  const d = DEFAULT_BATCH_SAVINGS;
  return {
    mode: r.mode === "individual" ? "individual" : "bulk",
    bulk: {
      embedding: choice(r.bulk?.embedding, d.bulk.embedding),
      llm: choice(r.bulk?.llm, d.bulk.llm),
    },
    jobs: {
      question_generation: choice(r.jobs?.question_generation, d.jobs.question_generation),
      ndcg_ranking: choice(r.jobs?.ndcg_ranking, d.jobs.ndcg_ranking),
      cluster_labeling: choice(r.jobs?.cluster_labeling, d.jobs.cluster_labeling),
      ingest_embedding: choice(r.jobs?.ingest_embedding, d.jobs.ingest_embedding),
    },
    // Absent (old rows) or non-boolean → the safe default (don't serve).
    semanticCache: { serve: r.semanticCache?.serve === true },
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
