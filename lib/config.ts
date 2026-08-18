// Central RAG configuration — every magic number and model name in one place.
//
// No API keys here, and no env var to read one from: under strict BYOK every
// provider credential belongs to a USER and is resolved through lib/llm/client.ts.
import { llmProviderOf, type LlmProviderId } from "@/lib/llm/llmModels";

export const config = {
  embeddingModel: "voyage-4-lite",
  llmModel: "claude-sonnet-4-6",
  chunkSize: 512,
  chunkOverlap: 50,
  topK: 5,
  maxAnswerTokens: 1024,
  // FrugalGPT cascade (lib/rag/efficacyGate.ts + pipeline.ask): answer with the
  // cheap model first, escalate to the config's llmModel only on an axis-2
  // (answer-quality) failure. The strong tier is whatever the config already uses,
  // so escalated queries see no quality change — the cascade only SAVES on easy ones.
  cascade: {
    // Per-config toggle: configs.cascade_enabled (0032), read via
    // activeConfig().cascadeEnabled. OFF (default) = one answer from the config's
    // llmModel, no gate, zero extra cost. The cheap first tier is derived from the
    // config's own llmModel per provider — see CHEAP_MODEL / cheapModelFor below.
    // Rung 1 (AXIS 1, pre-generation): retrieval cosine below which context is too
    // weak to answer from. A stronger model can't fix missing context, so below this
    // we answer once with the cheap model and NEVER escalate — a context-sufficiency
    // gate, not a quality score.
    retrievalHardFloor: 0.35,
    // AXIS 2 (rungs 0+2, post-generation) — the escalation trigger:
    efficacyThreshold: 0.6, // accept the cheap answer at/above this axis-2 [0,1] score
    groundednessTarget: 0.75, // rung 2: answer↔context cosine that counts as fully grounded
    minAnswerChars: 40, // rung 0: answers shorter than this are suspect
    shortPenalty: 0.6, // rung 0: score multiplier applied when the answer is too short
  },
  evalQuestionsPerChunk: 1, // target eval questions per chunk; generation tops up the difference
  // HNSW candidate pool: the top-N chunks nearest the question across the active
  // corpus, ranked under every aggregate model. Widening this mostly costs the
  // FIRST build — pool texts embed through the persistent embedding_cache (0020),
  // which is content-addressed, so a chunk is paid for once per model across all
  // questions and restarts.
  rankingPoolSize: 30,
  rankingLlmPoolSize: 8, // smaller subset sent to the LLM ranker (cost control)
  // Cluster preset drift (0033; see clusterStore.topUpSavedRuns). Fraction of a
  // preset's membership that arrived by top-up (nearest frozen centroid) rather
  // than by the k-means fit. Past this the centroids describe too little of the
  // corpus to trust and the UI says "re-fit". Not a hard block.
  clusterDriftThreshold: 0.2,
  // Max total upload size per ingest request, summed across files. Kept under
  // Vercel's 4.5 MB body cap to leave room for multipart overhead.
  maxUploadBytes: 4 * 1024 * 1024,
  // Master switch for the cache MECHANISM (populate + proximity match). Whether a
  // match is actually SERVED is a separate per-config toggle (Settings → Savings) —
  // the cache still fills with serving off.
  semanticCache: {
    enabled: true,
    // The CACHE-KEY model, overridable per config via
    // configs.batch_savings.semanticCache.keyModel. Deliberately its OWN setting
    // rather than the config's embeddingModel: the key vector never touches a
    // chunks_* table, and the tasks differ — retrieval is asymmetric query↔document,
    // cache matching is symmetric query↔query.
    //
    // Changing this moves every config holding no override into a NEW space, which
    // falls back to defaultThreshold — see resolveKeyModel / uncalibratedKeyModelSpace.
    keyModel: "voyage-4-lite",
    // Conservative cosine trigger for any (user, space) with no calibrated value in
    // semantic_cache_thresholds. High on purpose: in RAG a false hit is a wrong
    // answer. Phase 2 calibration lowers it per space only where the eval bank proves
    // it safe, and only for the account that ran it (0050).
    defaultThreshold: 0.95,
    // Safety cap on cached queries scored (in JS) per lookup, newest first. Raised
    // from 500 when the cache moved from per-config to per-user (0058): rows once
    // split across N configs now pool into one bucket.
    //
    // Not raised further without measuring. query_vector is real[], which postgres.js
    // decodes TEXT-encoded, so at 1024 dims a 2,000-row candidate set is tens of MB
    // pulled per lookup on the answer hot path. If this ever needs to be large, the
    // fix is pushing the narrowing into SQL (pgvector), not a bigger number here.
    maxCandidates: 1000,
    // Volume pruning. Replaces the eager fingerprint GC, which became a data-loss bug
    // under user scoping: a user now holds SEVERAL live fingerprints at once (one per
    // document set × saver-mode combination), so "delete this user's rows under any
    // other fingerprint" would wipe one config's live cache on every store by
    // another. Stale rows here are merely unreachable, never wrong, so they age out
    // by volume instead — 1 store in `pruneEvery`, dropping coldest/oldest first.
    maxEntriesPerUser: 2000,
    pruneEvery: 20,
    // Entity/number guard: a match whose numerals, ALLCAPS acronyms or quoted spans
    // DIFFER from the incoming question is refused, however high its cosine. "2023
    // revenue" vs "2024 revenue" lands near 0.98 under every embedding model — a
    // lexical failure no threshold or model swap fixes. Blocked matches are still
    // shadow-logged (guard_blocked, 0038) so the recall cost stays measurable.
    entityGuard: { enabled: true },
    // Shadow logging floor: a lookup records the best match at or above this cosine
    // as an unjudged semantic_cache_shadow row, INDEPENDENT of whether it clears the
    // serving threshold. It MUST sit well below defaultThreshold — calibrating the
    // threshold DOWNWARD needs judged examples below today's 0.95, which the serving
    // path would never surface.
    shadowLogFloor: 0.8,
    // …and a small random sample of the traffic BELOW that floor (F5). The floor
    // stays at 0.80 because F2 measured that band and found no τ can live there;
    // this samples it anyway so that if a different corpus, key model or question
    // mix ever changes that, it shows up in the data instead of staying invisible
    // by construction. Sampled rows are ordinary 'traffic' rows — they are real
    // traffic — but they are a 5% sample of their band next to a 100% census
    // above it, so calibrationCurve leaves them out of the serving curve unless
    // asked for them. 0 disables sampling.
    subFloorSampleRate: 0.05,
    // Recommend a threshold this far above the eval-bank distinct-question collision
    // floor, and keep it at least this far below the lowest same-answer pair when a
    // safe band exists.
    collisionMargin: 0.01,
    // Shadow-judge acceptance target: the sweep picks the lowest threshold τ
    // whose P(accept | sim ≥ τ) stays at or above this, given enough samples.
    acceptTarget: 0.99,
    // Minimum judged events required before the sweep will recommend a τ.
    minCalibrationSamples: 20,
    // Default judge models (UI-selectable per run). Bulk labels the easy majority
    // cheaply; boundary re-judges the sim band where acceptance crosses the target,
    // where a wrong label moves τ.
    judgeBulkModel: "claude-haiku-4-5",
    judgeBoundaryModel: "claude-sonnet-4-6",
    judgeModelOptions: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"],
    // Which model belongs on `keyModel`, decided by measurement rather than argument.
    // Deliberately NOT autotune: ~9 models is small enough to sweep exhaustively, so
    // this is a table you sort, not a search you run.
    keyModelSweep: {
      // Every registered model is a candidate — the key vector never touches a chunks_*
      // table, so `ingestable` is irrelevant. A listed model whose provider has no key
      // is REPORTED as unavailable rather than dropped, so a missing space is explained.
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
      // Per eval question. Hard negatives are the load-bearing half: random distinct
      // pairs are separated near-perfectly by every model and grade nothing.
      pairsPerQuestion: { paraphrase: 3, hardNegative: 3 },
      // Was claude-haiku-4-5 on the theory that writing question VARIANTS is much
      // easier than judging one. F3 measured that and it isn't true of the half
      // that matters: haiku scored 100% on paraphrases but only 80% on HARD
      // NEGATIVES — 15 of 90 were paraphrases wearing a negative's label, and the
      // sweep punishes exactly the models that score those correctly. Same price
      // per token as the judge this is screened against, and a one-off over the
      // whole bank.
      generateModel: "claude-sonnet-5",
      // Screen every generated pair through the shadow judge before storing it
      // (semanticCachePairs.generatePairs). The judge is the same rubric F3
      // audited with, so this turns the quarantine from a cleanup pass somebody
      // has to remember to run into a gate. Costs one judge call per pair.
      screenGeneratedPairs: true,
      // How many texts one model's scoring pass embeds PER CALL. The pass used
      // to embed one text at a time, to be gentle on provider rate limits —
      // which is the provider's business to enforce, not ours, and was not where
      // the time went anyway: warm, the loop was ~300 sequential round trips to
      // `embedding_cache` on the single connection a request scope holds.
      // Batching them is what made it fast; adding CONCURRENCY instead measured
      // at no improvement at all, because the shared transaction serializes the
      // reads however wide the caller goes.
      //
      // The size is a cancellation dial: `shouldStop` is checked between slices,
      // so this is how late a cancel can land, and how much work one failure
      // throws away. 128 is Voyage's own per-request cap, so a slice is a single
      // provider call for the models this sweep is mostly made of.
      embedSliceSize: 128,
    },
  },
} as const;

// The saver cascade's CHEAP FIRST TIER, one per provider. This was once the
// constant `cascade.cheapModel: "claude-haiku-4-5"`, which was correct for exactly
// as long as Anthropic was the only provider.
//
// Under a GPT config that constant made the cascade CROSS PROVIDERS: the cheap
// answer billed to the user's Anthropic key, the escalation to their OpenAI one —
// a wrong bill for a user holding both keys, a mid-answer MissingProviderKeyError
// for one holding a single key, and a meaningless savings number either way (it
// compares cheap-tier against strong-tier cost at one vendor's rate card).
//
// Deriving the tier from the config's llmModel keeps every cascade inside one
// provider and one key — the invariant the ledger and the error handling assume.
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

// False-positive detector threshold: a question that MISSED recall but whose
// graded nDCG is at least this high is likely a victim of distractor crowding —
// surfaced on /eval as a "possible false positive" hint next to the miss badge.
export const HIGH_NDCG = 0.7;

// Model ladder for the autotune engine, CHEAPEST FIRST as an explicit ordered
// list (no cost field exists in the registry to derive it from). The engine
// filters out the config's base model and any provider the RUNNING USER has no
// key for, so entries here are candidates, not guarantees.
//
// The domain-tuned Voyage models (code/finance/law) are each their own vector
// space, so unlike the voyage-4 family an override under one costs a fusion lane
// at retrieval — the Settings checklist labels that.
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

// The nDCG "aggregate" ideal ranking defaults to EVERY keyed model
// (lib/rag/embeddingModels.keyedModels) so the replay's leave-one-out correction
// applies evenly; Settings → Metrics → nDCG pins a narrower set per config (0045).
// It previously averaged four hard-coded models, which graded four of seven
// candidates against an ideal they had helped write.
//
// Keyed-only matters: an aggregate build embeds the pool under ALL voters eagerly,
// so a model whose provider has no key would stall or break the build for everyone.

