// ---------------------------------------------------------------------------
// ORCHESTRATION: ties the individual stages into two top-level flows.
//
// Ingestion flow (run when documents are added):
//   loader -> hash -> dedup (documents + document_embeddings)
//          -> chunker -> embeddings -> vectorStore
//
// Query flow (run per user question):
//   retriever -> generator -> answer (+ sources)
//
// The API routes should call THIS module, not the individual stages, so the
// HTTP layer stays dumb and the RAG logic stays testable in isolation.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

import { config } from "@/lib/config";
import { chunkDocument } from "@/lib/rag/chunker";
import { embedTexts } from "@/lib/rag/embeddings";
import { loadDocument, type LoadInput } from "@/lib/rag/loader";
import { retrieve } from "@/lib/rag/retriever";
import {
  findDocumentByHash,
  hasEmbeddingRun,
  insertDocument,
  insertEmbeddingRunWithChunks,
} from "@/lib/rag/vectorStore";
import type { RetrievedChunk, SourceDocument } from "@/types/rag";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function ingestOne(doc: SourceDocument): Promise<number> {
  const contentHash = sha256(doc.text);

  const existing = await findDocumentByHash(contentHash);
  const documentId = existing
    ? existing.id
    : await insertDocument(doc.metadata.fileName, contentHash);

  if (existing) {
    console.log(
      `[rag:pipeline] document "${doc.metadata.fileName}" already exists (id=${documentId.slice(0, 8)})`,
    );
  }

  // Already embedded under the current config? Nothing to do.
  if (
    await hasEmbeddingRun(
      documentId,
      config.embeddingModel,
      config.chunkSize,
      config.chunkOverlap,
    )
  ) {
    console.log(
      `[rag:pipeline] skip embed: ${doc.metadata.fileName} already embedded under ` +
        `model=${config.embeddingModel} size=${config.chunkSize} overlap=${config.chunkOverlap}`,
    );
    return 0;
  }

  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) return 0;

  const vectors = await embedTexts(chunks.map((c) => c.text));
  const dimension = vectors[0]?.length ?? 0;

  await insertEmbeddingRunWithChunks({
    documentId,
    model: config.embeddingModel,
    dimension,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    chunks: chunks.map((c, i) => ({
      position: c.position,
      text: c.text,
      embedding: vectors[i],
    })),
  });

  return chunks.length;
}

export async function ingest(input: LoadInput): Promise<{ chunksAdded: number }> {
  const t0 = performance.now();
  console.log(`[rag:pipeline] ingest start (kind=${input.kind})`);

  const documents = await loadDocument(input);
  const counts = await Promise.all(documents.map(ingestOne));
  const chunksAdded = counts.reduce((a, b) => a + b, 0);

  console.log(
    `[rag:pipeline] ingest done: ${chunksAdded} chunks in ${Math.round(performance.now() - t0)}ms`,
  );
  return { chunksAdded };
}

export async function ask(
  question: string,
): Promise<{ answer: string; sources: RetrievedChunk[] }> {
  const sources = await retrieve(question);
  const answer = `Retrieved ${sources.length} chunk${sources.length === 1 ? "" : "s"}. Generation is disabled — expand "sources" to inspect retrieval.`;
  return { answer, sources };
}
