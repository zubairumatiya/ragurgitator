// ---------------------------------------------------------------------------
// ORCHESTRATION: ties the individual stages into two top-level flows.
//
// Ingestion flow (run when documents are added):
//   loader -> chunker -> embeddings -> vectorStore
//
// Query flow (run per user question):
//   retriever -> generator -> answer (+ sources)
//
// The API routes should call THIS module, not the individual stages, so the
// HTTP layer stays dumb and the RAG logic stays testable in isolation.
// ---------------------------------------------------------------------------
import { chunkDocument } from "@/lib/rag/chunker";
import { embedTexts } from "@/lib/rag/embeddings";
import { loadDocument, type LoadInput } from "@/lib/rag/loader";
import { upsert } from "@/lib/rag/vectorStore";
import type { EmbeddedChunk } from "@/types/rag";

export async function ingest(input: LoadInput): Promise<{ chunksAdded: number }> {
  const documents = await loadDocument(input);

  // Chunk every document in parallel, then flatten so we can embed them in one
  // batched pass — embedTexts handles the 128-input batching internally.
  const chunksPerDoc = await Promise.all(documents.map(chunkDocument));
  const chunks = chunksPerDoc.flat();
  if (chunks.length === 0) return { chunksAdded: 0 };

  const vectors = await embedTexts(chunks.map((c) => c.text));

  const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
    chunk,
    embedding: vectors[i],
  }));
  await upsert(embedded);

  return { chunksAdded: embedded.length };
}

// TODO: export `ask(question): Promise<{ answer: string; sources: RetrievedChunk[] }>`
// once generator.ts is implemented. Shape will be:
//   const sources = await retrieve(question);
//   const answer  = await generateAnswer(question, sources);
//   return { answer, sources };
