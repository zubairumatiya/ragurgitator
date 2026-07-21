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
// TODO: export a typed config object. Read secrets from process.env, never
//       hard-code API keys here (see .env.example).
// ---------------------------------------------------------------------------
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
    // Opt-in saver mode. OFF (default) = today's behaviour: one answer from the
    // config's llmModel, no gate, zero extra cost. ON = Haiku-first + gate +
    // escalation. Seed of the "Savings" settings surface (alongside batch API +
    // the semantic answer cache); a persisted/UI toggle can later override this.
    enabled: false,
    cheapModel: "claude-haiku-4-5", // cheap first tier; strong tier = activeConfig().llmModel
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
  rankingNearestBuckets: 3, // cluster centroids nearest the question that seed the pool
  rankingPoolSize: 15, // candidate chunks ranked for the embedding aggregate
  rankingLlmPoolSize: 8, // smaller subset sent to the LLM ranker (cost control)
  // Max total upload size per ingest request, summed across files. Kept under
  // Vercel's 4.5 MB serverless body cap to leave room for multipart overhead;
  // raise it if you self-host behind your own limit.
  maxUploadBytes: 4 * 1024 * 1024,
} as const;

// Alternate embedding models offered by the per-chunk "try a different model"
// experiment (see lib/rag/eval.runModelTrial). This is an EPHEMERAL re-ranking
// tool: these models are never ingested into chunks_<model>_<dim> tables — the
// experiment re-embeds a small candidate pool in memory and ranks by cosine, so
// any output dimension works and no migration is needed to add one here.
//
// Cross-provider entries (OpenAI/Cohere/local) route through the embedding
// dispatcher (lib/rag/embeddingProviders.ts). They're OPT-IN: selecting one
// without its enabling env var (a key for OpenAI/Cohere; LOCAL_EMBEDDINGS for
// the local models) just fails that one trial as "unavailable" — it never
// touches the live index. This is why they live here and NOT in
// rankingAggregateModels (which embeds eagerly for every aggregate build — see
// below).
//
// Excludes the active embeddingModel (it's the baseline) and voyage-context-3
// (a different, contextualized embedding API that can't drop into embed()).
export const altEmbeddingModels: { id: string; label: string }[] = [
  { id: "voyage-4-large", label: "voyage-4-large" },
  { id: "voyage-4", label: "voyage-4" },
  { id: "voyage-code-3", label: "voyage-code-3" },
  { id: "voyage-code-2", label: "voyage-code-2" },
  { id: "voyage-finance-2", label: "voyage-finance-2" },
  { id: "voyage-law-2", label: "voyage-law-2" },
  // --- other providers (need a key / local weights; see embeddingModels.ts) ---
  { id: "text-embedding-3-large", label: "text-embedding-3-large (OpenAI)" },
  { id: "embed-v4", label: "embed-v4 (Cohere)" },
  { id: "mxbai-embed-large", label: "mxbai-embed-large (local)" },
  { id: "bge-m3", label: "bge-m3 (local)" },
];

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
// the config's base model and any provider whose enabling env var is unset
// (isProviderAvailable — keys for API providers, LOCAL_EMBEDDINGS for local),
// so entries here are candidates, not guarantees.
export const autotuneModelLadder: string[] = [
  "mxbai-embed-large",
  "bge-m3",
  "voyage-4-lite",
  "voyage-4",
  "voyage-4-large",
  "text-embedding-3-large",
  "embed-v4",
];

// Embedding models whose per-model rankings are averaged into the synthetic
// "aggregate" ideal ranking for graded nDCG (lib/rag/ranking.ts). The active
// model is the baseline; a few general-purpose alts add cross-model consensus.
// Like altEmbeddingModels these are re-embedded in memory, never ingested.
//
// Kept Voyage-only on purpose: every aggregate build embeds the pool under ALL of
// these eagerly, so adding a model that needs a key (OpenAI/Cohere) or a big
// weights download (local) would break or stall the aggregate for everyone.
// Expose those through altEmbeddingModels (opt-in) instead.
export const rankingAggregateModels: string[] = [
  config.embeddingModel,
  "voyage-4-large",
  "voyage-4",
  "voyage-code-3",
];
