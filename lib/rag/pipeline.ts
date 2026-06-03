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
import { labelFor, loadDocument, type LoadInput } from "@/lib/rag/loader";
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

// Ingestion stages, in order. The UI mirrors these as a step indicator.
export type IngestStep = "load" | "chunk" | "embed" | "store";

async function ingestOne(
  doc: SourceDocument,
  onStep: (step: IngestStep) => void = () => {},
): Promise<number> {
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

  onStep("chunk");
  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) return 0;

  onStep("embed");
  const vectors = await embedTexts(chunks.map((c) => c.text));
  const dimension = vectors[0]?.length ?? 0;

  onStep("store");
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

// One entry per input source: a chunk count on success, an error string on
// failure. A single bad file no longer sinks the whole batch.
export type IngestResult =
  | { fileName: string; chunksAdded: number }
  | { fileName: string; error: string };

// Progress events streamed to the client during ingestion. The route serializes
// these as NDJSON; the UI turns them into a progress bar + step indicator.
export type IngestEvent =
  | { type: "start"; total: number }
  | { type: "step"; index: number; fileName: string; step: IngestStep }
  | { type: "file-done"; index: number; result: IngestResult }
  | { type: "done"; results: IngestResult[] }
  | { type: "error"; message: string };

type Emit = (event: IngestEvent) => void;

// Sequential on purpose: ordered step events make for a clean progress UI, and
// it keeps us from firing every file's embeddings at the provider at once.
export async function ingest(
  inputs: LoadInput[],
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const t0 = performance.now();
  console.log(`[rag:pipeline] ingest start (${inputs.length} source(s))`);
  onEvent({ type: "start", total: inputs.length });

  const results: IngestResult[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    const fileName = labelFor(input);
    let result: IngestResult;
    try {
      onEvent({ type: "step", index, fileName, step: "load" });
      const doc = await loadDocument(input);
      const chunksAdded = await ingestOne(doc, (step) =>
        onEvent({ type: "step", index, fileName, step }),
      );
      result = { fileName, chunksAdded };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Ingestion failed.";
      console.error(`[rag:pipeline] ingest failed for "${fileName}": ${error}`);
      result = { fileName, error };
    }
    results.push(result);
    onEvent({ type: "file-done", index, result });
  }

  const chunksAdded = results.reduce(
    (sum, r) => sum + ("chunksAdded" in r ? r.chunksAdded : 0),
    0,
  );
  console.log(
    `[rag:pipeline] ingest done: ${chunksAdded} chunks from ${results.length} source(s) in ` +
      `${Math.round(performance.now() - t0)}ms`,
  );
  onEvent({ type: "done", results });
  return { results };
}

export async function ask(
  question: string,
): Promise<{ answer: string; sources: RetrievedChunk[] }> {
  const sources = await retrieve(question);
  const answer = `Retrieved ${sources.length} chunk${sources.length === 1 ? "" : "s"}. Generation is disabled — expand "sources" to inspect retrieval.`;
  return { answer, sources };
}
