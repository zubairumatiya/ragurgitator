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
// without its key (OpenAI/Cohere) or before its weights download (local) just
// fails that one trial with an error — it never touches the live index. This is
// why they live here and NOT in rankingAggregateModels (which embeds eagerly for
// every aggregate build — see below).
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
// the config's base model and any provider without a key/weights at run time
// (isProviderAvailable), so entries here are candidates, not guarantees.
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
