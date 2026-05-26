// ---------------------------------------------------------------------------
// STEP 4 of ingestion: STORE  (and the backend for retrieval)
//
// Persists EmbeddedChunks and answers nearest-neighbor queries. This is the
// in-memory implementation: a plain array held in the process. It is fast and
// dependency-free, but the data is lost on restart — re-run ingestion, or swap
// in a file/DB backend later behind this same upsert/query interface.
// ---------------------------------------------------------------------------
import type { EmbeddedChunk, RetrievedChunk } from "@/types/rag";

// Lives in RAM for the lifetime of the process. Not shared across instances,
// not persisted — see the module header.
const store: EmbeddedChunk[] = [];

export type IngestedDocument = {
  id: string;
  fileName: string;
  chunkCount: number;
  ingestedAt: number;
};

const documents = new Map<string, IngestedDocument>();

// Voyage returns unit-length vectors, so cosine similarity is just the dot
// product — no need to divide by magnitudes, both are already 1.
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export async function upsert(chunks: EmbeddedChunk[]): Promise<void> {
  store.push(...chunks);
  console.log(
    `[rag:vectorStore] upserted ${chunks.length} chunks (store size: ${store.length})`,
  );
}

export async function query(
  vector: number[],
  topK: number,
): Promise<RetrievedChunk[]> {
  return store
    .map((chunk) => ({ score: dotProduct(vector, chunk.embedding), chunk }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export async function registerDocument(
  doc: Omit<IngestedDocument, "ingestedAt">,
): Promise<void> {
  documents.set(doc.id, { ...doc, ingestedAt: Date.now() });
}

export async function listDocuments(): Promise<IngestedDocument[]> {
  return [...documents.values()].sort((a, b) => b.ingestedAt - a.ingestedAt);
}
