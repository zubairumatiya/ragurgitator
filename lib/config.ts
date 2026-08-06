// ---------------------------------------------------------------------------
// Central RAG configuration.
//
// Keep every "magic number" and model name here so the rest of the codebase
// reads from one place. Things you'll likely want to define:
//
//   - embeddingModel : which embedding model you call (name + dimensions)
//   - llmModel       : which chat/generation model answers the question
//   - chunkSize      : how many tokens/characters per chunk
//   - chunkOverlap   : how much neighboring chunks overlap (preserves context)
//   - topK           : how many chunks to retrieve per query
//
// TODO: export a typed config object.
//
// There are no API keys to hard-code here any more, and no env var to read one
// from either: under strict BYOK every provider credential belongs to a USER and
// is resolved through lib/llm/client.ts (docs/user-accounts-plan.md §5).
// ---------------------------------------------------------------------------
import { llmProviderOf, type LlmProviderId } from "@/lib/llm/llmModels";

export const config = {
  embeddingModel: "voyage-4-lite",
  llmModel: "claude-sonnet-4-6",
  chunkSize: 512,
  chunkOverlap: 50,
  topK: 5,
  maxAnswerTokens: 1024,
  // FrugalGPT cascade (lib/rag/efficacyGate.ts + pipeline.ask): the primary
  // Phase-E savings lever (docs/long-term-savings-research.md §4.2). Answer with
  // the cheap model first, then escalate to the config's llmModel only on an
  // axis-2 (answer-quality) failure. The strong tier is whatever the active config
  // already uses, so escalated (hard) queries see no quality change — the cascade
  // only SAVES on easy ones. Every number below is tunable; efficacyThreshold is
  // the exact knob a "sweep" would optimize.
  cascade: {
    // Saver mode is a PER-CONFIG toggle: configs.cascade_enabled (migration 0032),
    // read via activeConfig().cascadeEnabled and flipped in Settings → Savings.
    // OFF (default) = today's behaviour: one answer from the config's llmModel, no
    // gate, zero extra cost. ON = Haiku-first + gate + escalation. The knobs below
    // are the (still global) cascade parameters.
    // The cheap first tier is NOT a constant here — it is derived from the
    // config's own llmModel, per provider. See CHEAP_MODEL / cheapModelFor below.
    // Rung 1 (AXIS 1, pre-generation): retrieval cosine below which context is too
    // weak to answer from. A stronger model can't fix missing context, so below
    // this we answer once with the cheap model and NEVER escalate. Not a quality
    // score — a context-sufficiency gate.
    retrievalHardFloor: 0.35,
    // AXIS 2 (rungs 0+2, post-generation) — the escalation trigger:
    efficacyThreshold: 0.6, // accept the cheap answer at/above this axis-2 [0,1] score
    groundednessTarget: 0.75, // rung 2: answer↔context cosine that counts as fully grounded
    minAnswerChars: 40, // rung 0: answers shorter than this are suspect
    shortPenalty: 0.6, // rung 0: score multiplier applied when the answer is too short
  },
  evalQuestionsPerChunk: 1, // target eval questions per chunk; generation tops up the difference
  // --- Graded-nDCG ranking builder (/eval; see lib/rag/ranking.ts) ----------
  // HNSW candidate pool: the top-N chunks nearest the question across the whole
  // active corpus (rankingStore.poolNearest), ranked under every aggregate model.
  // Widening this mostly costs the FIRST build — pool texts are embedded through
  // the persistent embedding_cache (lib/rag/embedCache.ts, migration 0020), which
  // is content-addressed, so the same chunk is paid for once per model across all
  // questions and restarts rather than once per build.
  rankingPoolSize: 30,
  rankingLlmPoolSize: 8, // smaller subset sent to the LLM ranker (cost control)
  // --- Cluster preset drift (migration 0033; see clusterStore.topUpSavedRuns) -
  // Fraction of a preset's CURRENT membership that arrived by top-up (nearest
  // frozen centroid) rather than by the k-means fit. Past this, the centroids
  // describe too little of the corpus to trust and the UI says "re-fit". Not a
  // hard block: a drifted preset still builds usable pools, since the pool is
  // re-sorted by similarity to the question and truncated.
  clusterDriftThreshold: 0.2,
  // Max total upload size per ingest request, summed across files. Kept under
  // Vercel's 4.5 MB serverless body cap to leave room for multipart overhead;
  // raise it if you self-host behind your own limit.
  maxUploadBytes: 4 * 1024 * 1024,
  // --- Semantic answer cache (docs/semantic-caching-plan.md, migration 0031) --
  // Master switch for the cache MECHANISM (populate + proximity match). Whether
  // a match is actually SERVED is a separate per-config toggle ("Serve cached
  // answers", Settings → Savings, configs.batch_savings) — the cache still fills
  // with serving off. `enabled: false` makes ask() behave exactly as before;
  // the table not existing degrades it to a no-op too.
  semanticCache: {
    enabled: true,
    // The CACHE-KEY model (docs/semantic-cache-key-model-plan.md, Phase 1) —
    // the global default, overridable per config via
    // configs.batch_savings.semanticCache.keyModel. Deliberately its OWN
    // setting rather than the config's embeddingModel: the cache-key vector
    // never touches a chunks_* table, so nothing forced the coupling, and the
    // two are different tasks — retrieval is asymmetric query↔document, cache
    // matching is symmetric query↔query. It's also paid per incoming question
    // (~10 tokens), not per corpus chunk, so the best question model is
    // affordable here regardless of what a config retrieves with.
    //
    // Kept at voyage-4-lite (= the historical cfg.embeddingModel) so every
    // judged semantic_cache_shadow row stays in its captured space and keeps
    // funding that space's calibration. Changing this moves every config that
    // holds no override into a NEW space, which falls back to
    // defaultThreshold — see resolveKeyModel / uncalibratedKeyModelSpace.
    keyModel: "voyage-4-lite",
    // Conservative cosine trigger for any (user, space) without a calibrated
    // value in semantic_cache_thresholds. High on purpose: in RAG a false hit
    // is a wrong answer (see the plan doc). Phase 2 calibration lowers it per
    // space only where the eval bank proves it's safe, and only for the account
    // that ran it (0050).
    defaultThreshold: 0.95,
    // Safety cap on cached queries scored (in JS) per lookup for one config.
    maxCandidates: 500,
    // Entity/number guard (docs/semantic-cache-key-model-plan.md, Phase 0): a
    // match whose numerals, ALLCAPS acronyms or quoted spans DIFFER from the
    // incoming question is refused, however high its cosine. "2023 revenue" vs
    // "2024 revenue" lands near 0.98 under every embedding model — a lexical
    // failure that no threshold or model swap fixes. Off restores the pre-guard
    // behaviour exactly. A blocked match is still shadow-logged (guard_blocked,
    // migration 0038) so the recall it costs stays measurable.
    entityGuard: { enabled: true },
    // --- Phase 2 calibration (docs/semantic-caching-plan.md) ---------------
    // Shadow logging floor: a lookup records the best match at or above this
    // cosine as an (unjudged) semantic_cache_shadow row, INDEPENDENT of whether
    // the match clears the serving threshold. It MUST sit well below
    // defaultThreshold — to calibrate the threshold DOWNWARD we need judged
    // examples below today's 0.95, which the serving path would never surface.
    shadowLogFloor: 0.8,
    // Collision-floor calibration: recommend a threshold this far above the
    // eval-bank distinct-question collision floor (safety margin over "no false
    // hits on the eval bank"), and keep it at least this far below the lowest
    // same-answer pair when a safe band exists.
    collisionMargin: 0.01,
    // Shadow-judge acceptance target: the sweep picks the lowest threshold τ
    // whose P(accept | sim ≥ τ) stays at or above this, given enough samples.
    acceptTarget: 0.99,
    // Minimum judged events required before the sweep will recommend a τ.
    minCalibrationSamples: 20,
    // Default judge models (UI-selectable per run). Bulk labels the easy
    // majority cheaply; boundary re-judges the sim band where acceptance
    // crosses the target, where a wrong label moves τ. Kept on the models this
    // app already runs; add options in judgeModelOptions to offer more.
    judgeBulkModel: "claude-haiku-4-5",
    judgeBoundaryModel: "claude-sonnet-4-6",
    judgeModelOptions: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"],
    // --- Cache-key model sweep (docs/semantic-cache-key-model-plan.md, Ph. 2) -
    // Which model belongs on `keyModel`, decided by measurement rather than
    // argument. Deliberately NOT autotune: ~9 models is small enough to sweep
    // exhaustively, so this is a table you sort, not a search you run.
    keyModelSweep: {
      // Every registered model is a candidate — the cache-key vector never
      // touches a chunks_* table, so `ingestable` is irrelevant here. The sweep
      // filters out providers with no key/weights at run time (a listed model
      // whose provider is unavailable is REPORTED as unavailable, not dropped,
      // so a missing space is explained rather than silently absent).
      candidates: [
        "voyage-4-lite",
        "voyage-4",
        "voyage-4-large",
        "voyage-code-3",
        "voyage-code-2",
        "voyage-finance-2",
        "voyage-law-2",
        "text-embedding-3-large",
        "embed-v4",
        "mxbai-embed-large",
        "bge-m3",
      ],
      // Per eval question. Hard negatives are the load-bearing half: random
      // distinct pairs are separated near-perfectly by every model and grade
      // nothing, so the eval is exactly as good as these.
      pairsPerQuestion: { paraphrase: 3, hardNegative: 3 },
      // Cheap model on purpose — this writes question VARIANTS, which is a much
      // easier task than judging one, and it's a one-off over the whole bank.
      generateModel: "claude-haiku-4-5",
    },
  },
} as const;

// The saver cascade's CHEAP FIRST TIER, one per provider (docs/user-accounts-plan.md
// §9.1). This used to be the constant `cascade.cheapModel: "claude-haiku-4-5"`,
// which was correct for exactly as long as Anthropic was the only provider.
//
// Under a GPT config that constant made the cascade CROSS PROVIDERS: the cheap
// first answer billed to the user's Anthropic key, the escalation to their OpenAI
// one. That is a wrong bill for a user who holds both keys and an outright
// failure (MissingProviderKeyError, mid-answer) for a user who holds one. Worse,
// it would have made the cascade's own savings number meaningless — it compares
// cheap-tier cost against strong-tier cost, and the two would no longer be the
// same vendor's rate card.
//
// Deriving the tier from the config's llmModel keeps every cascade inside one
// provider and one key, which is the invariant the ledger and the error handling
// both assume.
export const CHEAP_MODEL: Record<LlmProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.6-luna",
};

// The cheap tier for a config whose strong tier is `llmModel`. Throws on a model
// id with no recognisable provider prefix — the same id would fail at the
// generation call a moment later, so failing here names the actual problem.
export function cheapModelFor(llmModel: string): string {
  return CHEAP_MODEL[llmProviderOf(llmModel)];
}

// False-positive detector threshold (eval-autotuning-plan §7): a question that
// MISSED recall but whose graded nDCG is at least this high is likely a victim
// of distractor crowding (the ground truth ranks well against its ideal, other
// legitimately-relevant chunks pushed it out of top-k) — surfaced on /eval as a
// "possible false positive" hint next to the miss badge.
export const HIGH_NDCG = 0.7;

// Model ladder for the autotune engine (eval-autotuning-plan §5.2, A4):
// CHEAPEST FIRST, as an explicit ordered list (no cost field exists in the
// registry to derive it from). Free local models lead (slower but $0), then
// Voyage from lite upward, then keyed providers last. The engine filters out
// the config's base model and any provider the RUNNING USER has no key for
// (availableProviders() — a saved key for the API providers, LOCAL_EMBEDDINGS
// for local), so entries here are candidates, not guarantees, and the same
// ladder yields a different run for two users with different keys.
// The domain-tuned Voyage models (code/finance/law) sit in the Voyage band at
// their own price. Each is its own vector space, so unlike the voyage-4 family
// an override under one costs a fusion lane at retrieval — the Settings
// checklist labels that, and unchecking a space is how you opt out.
export const autotuneModelLadder: string[] = [
  "mxbai-embed-large",
  "bge-m3",
  "voyage-4-lite",
  "voyage-4",
  "voyage-4-large",
  "voyage-code-2",
  "voyage-finance-2",
  "voyage-law-2",
  "voyage-code-3",
  "text-embedding-3-large",
  "embed-v4",
];

// The nDCG "aggregate" ideal ranking (lib/rag/ranking.ts) used to average a
// hard-coded four models here: the active model plus voyage-4-large, voyage-4
// and voyage-code-3.
//
// That list is gone. It made nDCG unfair in a way that only became visible once
// Appraise → Models scored every model on the same corpus: four of the seven
// candidates were graded against an ideal they had helped write, and every
// non-contributor landed in the bottom half. The default is now EVERY keyed
// model (lib/rag/embeddingModels.keyedModels), so the replay's leave-one-out
// correction applies evenly to all of them, and Settings → Metrics → nDCG →
// "Models in aggregate" pins a narrower set per config (migration 0045).
//
// The old comment's warning still holds and is why the default is keyed-only:
// an aggregate build embeds the pool under ALL voters eagerly, so a model whose
// provider has no key would stall or break the build for everyone.

