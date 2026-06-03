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
  // Max total upload size per ingest request, summed across files. Kept under
  // Vercel's 4.5 MB serverless body cap to leave room for multipart overhead;
  // raise it if you self-host behind your own limit.
  maxUploadBytes: 4 * 1024 * 1024,
} as const;
