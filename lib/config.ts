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
// Excludes the active embeddingModel (it's the baseline) and voyage-context-3
// (a different, contextualized embedding API that can't drop into embed()).
export const altEmbeddingModels: { id: string; label: string }[] = [
  { id: "voyage-4-large", label: "voyage-4-large" },
  { id: "voyage-4", label: "voyage-4" },
  { id: "voyage-code-3", label: "voyage-code-3" },
  { id: "voyage-code-2", label: "voyage-code-2" },
  { id: "voyage-finance-2", label: "voyage-finance-2" },
  { id: "voyage-law-2", label: "voyage-law-2" },
];

// Embedding models whose per-model rankings are averaged into the synthetic
// "aggregate" ideal ranking for graded nDCG (lib/rag/ranking.ts). The active
// model is the baseline; a few general-purpose alts add cross-model consensus.
// Like altEmbeddingModels these are re-embedded in memory, never ingested.
export const rankingAggregateModels: string[] = [
  config.embeddingModel,
  "voyage-4-large",
  "voyage-4",
  "voyage-code-3",
];
