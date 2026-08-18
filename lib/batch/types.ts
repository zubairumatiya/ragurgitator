// BATCH API — shared vocabulary. The four offline JOB KINDS, the two provider
// LEGS the Settings dropdown groups them into, the per-config SAVINGS preference
// + its effective-choice resolver, and the normalized job STATUS lifecycle.
// No I/O — pure types + tiny helpers, so it imports nothing and serves server and
// client code alike.

// Which batch API a job is submitted to. NOT a per-kind fact: both LLM providers
// serve a batch API, and which one a job goes to follows from the MODEL its
// requests carry. Hence no `providerOfKind(kind)` — only the job's build() knows
// which model it put in the requests, so build() names the provider (BuiltBatch).
export type BatchProvider = "anthropic" | "openai" | "voyage";

// The offline surfaces that may run through a batch API (chat answers and live
// query embeds are excluded by design — they're interactive).
export const JOB_KINDS = [
  "question_generation",
  "ndcg_ranking",
  "cluster_labeling",
  "ingest_embedding",
  "cache_pair_generation",
  "cache_pair_screen",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_LABELS: Record<JobKind, string> = {
  question_generation: "Question generation",
  ndcg_ranking: "nDCG LLM ranking",
  cluster_labeling: "Cluster labeling",
  ingest_embedding: "Ingest / re-embedding",
  cache_pair_generation: "Cache-key eval pairs",
  cache_pair_screen: "Cache-key pair screen",
};

// The two "settings" the user groups jobs into: the embedding leg is just
// ingest_embedding, the LLM leg is everything else. Still a per-KIND fact even
// though the provider is not — the dropdown groups by "embedding vs answer
// generation", which stays true whichever vendor serves either leg.
export type BatchLeg = "embedding" | "llm";
export function legOfKind(kind: JobKind): BatchLeg {
  return kind === "ingest_embedding" ? "embedding" : "llm";
}

export type BatchChoice = "standard" | "batch";

export type BatchSavings = {
  // One choice per job, full stop. There are only four, so grouping them behind
  // per-leg settings (as earlier versions did) bought nothing but a layer.
  jobs: Record<JobKind, BatchChoice>;
  // Serve a stored answer for a near-duplicate question, skipping
  // retrieval/generation. This governs only whether a HIT is SERVED — the cache is
  // always populated, so turning `serve` on later has data to hit against. Opt-in:
  // a served hit can be wrong if the proximity threshold is loose.
  //
  // `threshold`, `keyModel` and `acceptTarget` are all tri-state overrides where
  // null = inherit (the norm); resolution order lives in semanticCache.
  //
  // `threshold` overrides the cosine floor a match must clear. The space table is
  // keyed by VECTOR-SPACE, shared by every config on the same embedding model, so
  // this is how one config runs looser or tighter than its space-mates.
  //
  // `keyModel` overrides the model incoming questions are embedded under for the
  // proximity match — decoupled from the config's retrieval model.
  //
  // `acceptTarget` overrides the PRECISION the calibration sweeps hold themselves
  // to — P(accept | sim ≥ τ) — not a cosine. It is the safety dial: raising it
  // picks a stricter τ that serves less, lowering it serves more and admits more
  // wrong answers. Separate from `threshold` on purpose: that sets τ by hand, this
  // sets the RULE deriving τ from judged evidence. Note the target is only
  // reachable when the served prefix is big enough — clearing 0.99 with r rejects
  // needs n ≥ 100r, so on a small judged set it means "zero false positives" and no
  // τ is recommended at all, which calibrateFromJudged reports as an attainability
  // blocker rather than a bare null.
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
    // CHAINED, never chosen. The screen has no synchronous twin to prefer — it is
    // submitted by cache_pair_generation's chain hook (and by the panel's own
    // button), so this entry exists only to keep the map total. EvalSettings
    // hides it for the same reason.
    cache_pair_screen: "batch",
  },
  semanticCache: { serve: false, threshold: null, keyModel: null, acceptTarget: null },
};

// THE resolver every launch point calls to decide "submit a batch or run inline?"
// — now a plain lookup, but kept a function so launch points needn't care.
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
// preference — missing/invalid fields fall back to the default.
//
// Also MIGRATES the two shapes predating the flat per-job map. There is no SQL
// migration: old rows keep their jsonb until something saves over them, and this
// converts on every read, preserving each job's EFFECTIVE choice.
//
//   1. `{ mode, bulk, jobs }` — `mode` picked WHICH map to read, leaving the other
//      dead. Under mode:'bulk' the jobs map holds stale values that were never in
//      force, so it must be ignored rather than merged.
//   2. `{ bulk, jobs }` with nullable jobs — legs as a base, jobs as an override
//      layer (null = inherit). Resolved by `jobs[k] ?? leg`.
// A threshold override is only honoured when it's a real cosine in [0,1].
// Anything else — absent, null, a string from a hand-edited blob, NaN — means
// INHERIT, which is also the safe outcome: the space calibration or conservative
// default takes over rather than an unusable number reaching the serving gate.
function coerceThreshold(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

// Same tri-state for the cache-key model: anything that isn't a non-empty string
// means INHERIT. Whether the string names a REGISTERED model isn't decided here —
// this file is deliberately import-free (client code reads it) and the registry is
// server-side. The write path validates the id, and resolveKeyModel falls back to
// the default on an unknown one, so a hand-edited blob degrades to the default
// rather than to a provider error on the hot path.
function coerceKeyModel(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// A precision-target override is only honoured inside [0.5, 1]. The upper bound is
// definitional; the LOWER bound is a judgement — below 0.5 the sweep would be told
// "most of what you serve may be wrong", which no caller means, and would collapse
// τ toward serving everything. Out of band means INHERIT.
//
// 1 IS allowed and differs from "unset": it demands a perfectly clean served
// prefix, which is attainable — it just makes requiredN meaningless, which
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
      // Not resolved: nothing reads a preference for the chained screen, and a
      // legacy blob's llm-leg "standard" would otherwise read back as a choice
      // the UI never offered and no launch point honours.
      cache_pair_screen: "batch",
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
// provider_batch_id to name. This predicate gates the panel's Cancel button, so
// including submitting rendered a button whose click did nothing at all. A
// stranded submit's exit is failStaleSubmittingJobs, not a cancel it can't perform.
export function isCancelable(status: BatchStatus): boolean {
  return status === "in_progress";
}

// One request to submit. `params` is an Anthropic MessageCreateParams for both LLM
// providers (the OpenAI adapter translates it per JSONL line) or a Voyage
// embeddings body.
//
// `customId` MUST match Anthropic's ^[a-zA-Z0-9_-]{1,64}$ — build it with
// batchCustomId() below rather than by hand.
export type BatchRequest = { customId: string; params: unknown };

// Join parts into a provider-safe custom id.
//
// ANTHROPIC ENFORCES ^[a-zA-Z0-9_-]{1,64}$ AND REJECTS THE WHOLE BATCH when one id
// fails it — a 400 naming only `requests.0.custom_id`, which says nothing about
// which builder produced it. OpenAI accepts `:`, so the same id shape works on one
// LLM leg and fails on the other, and nothing catches it until a real submit.
//
// Length is the other half: 64 characters is two uuids and little else.
export function batchCustomId(...parts: (string | number)[]): string {
  return parts.join("_");
}

// A normalized result row, provider-agnostic. `body` is an Anthropic Message —
// including on the OpenAI leg, whose ChatCompletion bodies the adapter translates
// back into that shape, which is what lets every apply() handler read
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
