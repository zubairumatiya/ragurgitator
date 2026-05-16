// ---------------------------------------------------------------------------
// STEP 4 of ingestion: STORE  (and the backend for retrieval)
//
// Responsibility: persist EmbeddedChunks and answer nearest-neighbor queries.
//
// Start simple to learn the mechanics, then swap the implementation later
// without touching the rest of the app (that's why this is its own module):
//   - learning option: an in-memory array + cosine similarity by hand
//   - local option:    a JSON file on disk under /data/vector-store
//   - real option:     a vector DB (pgvector, Pinecone, Chroma, etc.)
//
// Suggested interface to keep stable across implementations:
//   - upsert(chunks: EmbeddedChunk[]): Promise<void>
//   - query(vector: number[], topK: number): Promise<RetrievedChunk[]>
//
// TODO: implement cosine similarity here (or in a math util) for the
//       in-memory version first — it's the best way to understand retrieval.
// ---------------------------------------------------------------------------
