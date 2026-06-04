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
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { embedQuery } from "@/lib/rag/embeddings";
import { query } from "@/lib/rag/vectorStore";
import type { RetrievedChunk } from "@/types/rag";

export async function retrieve(question: string): Promise<RetrievedChunk[]> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Cannot retrieve for an empty question.");

  const vector = await embedQuery(trimmed);
  return retrieveWithVector(vector);
}

// The vector-search half of retrieve(), for callers that already hold the query
// embedding — e.g. eval scoring, which reuses cached question vectors instead of
// re-embedding (see lib/rag/eval.ts). Same top-k search, no embedding call.
export function retrieveWithVector(vector: number[]): Promise<RetrievedChunk[]> {
  return query(vector, config.topK);
}
