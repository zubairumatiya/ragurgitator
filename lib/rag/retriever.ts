// ---------------------------------------------------------------------------
// QUERY TIME, STEP 1: RETRIEVE
//
// Responsibility: given the user's question, find the most relevant chunks.
//
// Flow:
//   1. embedQuery(question)          -> query vector        (embeddings.ts)
//   2. vectorStore.query(vec, topK) -> top-K RetrievedChunks (vectorStore.ts)
//   3. (optional, later) re-rank or filter the results
//
// This module is the "R" in RAG. Keep it thin — it orchestrates embeddings +
// vectorStore, it doesn't reimplement them.
//
// TODO: export `retrieve(question: string): Promise<RetrievedChunk[]>`
// ---------------------------------------------------------------------------
