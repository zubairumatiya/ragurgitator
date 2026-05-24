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
import { generateAnswer } from "@/lib/rag/generator";
import { loadDocument, type LoadInput } from "@/lib/rag/loader";
import { retrieve } from "@/lib/rag/retriever";
import { upsert } from "@/lib/rag/vectorStore";
import type { EmbeddedChunk, RetrievedChunk } from "@/types/rag";

export async function ingest(input: LoadInput): Promise<{ chunksAdded: number }> {
  const t0 = performance.now();
  console.log(`[rag:pipeline] ingest start (kind=${input.kind})`);

  const documents = await loadDocument(input);

  // Chunk every document in parallel, then flatten so we can embed them in one
  // batched pass — embedTexts handles the 128-input batching internally.
  const chunksPerDoc = await Promise.all(documents.map(chunkDocument));
  const chunks = chunksPerDoc.flat();
  if (chunks.length === 0) {
    console.log(`[rag:pipeline] ingest done: 0 chunks in ${Math.round(performance.now() - t0)}ms`);
    return { chunksAdded: 0 };
  }

  const vectors = await embedTexts(chunks.map((c) => c.text));

  const embedded: EmbeddedChunk[] = chunks.map((chunk, i) => ({
    chunk,
    embedding: vectors[i],
  }));
  await upsert(embedded);

  console.log(
    `[rag:pipeline] ingest done: ${embedded.length} chunks in ${Math.round(performance.now() - t0)}ms`,
  );
  return { chunksAdded: embedded.length };
}

export async function ask(
  question: string,
): Promise<{ answer: string; sources: RetrievedChunk[] }> {
  const sources = await retrieve(question);
  const answer = await generateAnswer(question, sources);
  return { answer, sources };
}
