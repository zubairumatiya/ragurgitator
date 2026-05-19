// ---------------------------------------------------------------------------
// Central RAG configuration.
//
// Keep every "magic number" and model name here so the rest of the codebase
// reads from one place. Things you'll likely want to define:
//
//   - EMBEDDING_MODEL   : which embedding model you call (name + dimensions)
//   - LLM_MODEL         : which chat/generation model answers the question
//   - CHUNK_SIZE        : how many tokens/characters per chunk
//   - CHUNK_OVERLAP     : how much neighboring chunks overlap (preserves context)
//   - TOP_K             : how many chunks to retrieve per query
//
// TODO: export a typed config object. Read secrets from process.env, never
//       hard-code API keys here (see .env.example).
// ---------------------------------------------------------------------------
export const config = {
  EMBEDDING_MODEL: "voyage-4-lite",
  LLM_MODEL: "claude-sonnet-4-6",
  CHUNK_SIZE: 512,
  CHUNK_OVERLAP: 50,
  TOP_K: 5,
} as const;
