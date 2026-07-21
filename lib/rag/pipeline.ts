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
import { activeConfig, resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { chunkDocument } from "@/lib/rag/chunker";
import {
  addDocumentToCorpus,
  dedupCorporaDocuments,
  documentsForEmbedding,
  type EmbeddableDoc,
} from "@/lib/rag/corpusStore";
import { getConfig, listSyncedConfigIds } from "@/lib/rag/configStore";
import { embedTexts } from "@/lib/rag/embeddings";
import { labelFor, loadDocument, type LoadInput } from "@/lib/rag/loader";
import { retrieve, retrieveForQuery } from "@/lib/rag/retriever";
import { semanticCacheLookup, semanticCacheStore } from "@/lib/rag/semanticCache";
import {
  deleteEmbeddingRunFor,
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
  const cfg = activeConfig();
  const contentHash = sha256(doc.text);

  const existing = await findDocumentByHash(contentHash);
  const documentId = existing
    ? existing.id
    : await insertDocument(doc.metadata.fileName, contentHash, doc.text);

  if (existing) {
    console.log(
      `[rag:pipeline] document "${doc.metadata.fileName}" already exists (id=${documentId.slice(0, 8)})`,
    );
  }

  // Auto-sync (0017): only a synced config's uploads join its corpus. Detached
  // or sync-off configs keep their docs to themselves — corpora are a reusable
  // selection tool, not a mirror of every config.
  if (cfg.corpusId && cfg.corpusSync) {
    await addDocumentToCorpus(cfg.corpusId, documentId);
  }

  // Already embedded under the active config? Nothing to do.
  if (await hasEmbeddingRun(documentId)) {
    console.log(
      `[rag:pipeline] skip embed: ${doc.metadata.fileName} already embedded under ` +
        `config=${cfg.id.slice(0, 8)} (${cfg.embeddingModel} size=${cfg.chunkSize} overlap=${cfg.chunkOverlap})`,
    );
    return 0;
  }

  onStep("chunk");
  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) return 0;

  onStep("embed");
  const vectors = await embedTexts(chunks.map((c) => c.text));

  onStep("store");
  await insertEmbeddingRunWithChunks({
    documentId,
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

// Core of every "embed stored docs, no re-upload" flow: chunk → embed → store
// each doc (raw text persisted at first ingest, migration 0010) into the ACTIVE
// config; already-embedded docs are no-ops. Emits step/file-done events only —
// the caller owns start/done so several passes can share one progress stream.
// `indexOffset` keeps indexes continuous across passes; `fileLabel` decorates
// names (e.g. "doc.md → config-X" during a multi-config sync).
async function embedStoredDocs(
  docs: EmbeddableDoc[],
  onEvent: Emit,
  indexOffset = 0,
  fileLabel: (name: string) => string = (name) => name,
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const index = indexOffset + i;
    const fileName = fileLabel(d.fileName);
    let result: IngestResult;
    try {
      if (await hasEmbeddingRun(d.id)) {
        result = { fileName, chunksAdded: 0 };
      } else {
        const doc: SourceDocument = {
          id: d.id,
          text: d.content,
          metadata: { fileName: d.fileName },
        };
        onEvent({ type: "step", index, fileName, step: "chunk" });
        const chunks = await chunkDocument(doc);
        onEvent({ type: "step", index, fileName, step: "embed" });
        const vectors = await embedTexts(chunks.map((c) => c.text));
        onEvent({ type: "step", index, fileName, step: "store" });
        await insertEmbeddingRunWithChunks({
          documentId: d.id,
          chunks: chunks.map((c, i2) => ({
            position: c.position,
            text: c.text,
            embedding: vectors[i2],
          })),
        });
        result = { fileName, chunksAdded: chunks.length };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Embedding failed.";
      console.error(`[rag:pipeline] stored-doc embed failed for "${fileName}": ${error}`);
      result = { fileName, error };
    }
    results.push(result);
    onEvent({ type: "file-done", index, result });
  }
  return results;
}

// Embed the de-duplicated union of several corpora's stored documents into the
// ACTIVE config — the "spawn a config from corpora" flow (multi-select create).
// The same file uploaded twice (two doc rows, one content hash) embeds once.
// Docs without stored text (pre-0010) are skipped and reported. Must run inside
// withConfig(...); streams the same IngestEvents as ingest().
export async function embedCorpora(
  corpusIds: string[],
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const cfg = activeConfig();
  const t0 = performance.now();
  const { docs: selected } = await dedupCorporaDocuments(corpusIds);
  const docs = await documentsForEmbedding(selected.map((d) => d.id));
  console.log(
    `[rag:pipeline] spawn-embed ${corpusIds.length} corpus(es) into config=${cfg.id.slice(0, 8)}: ` +
      `${docs.length}/${selected.length} doc(s) with stored text`,
  );
  onEvent({ type: "start", total: docs.length });
  const results = await embedStoredDocs(docs, onEvent);
  console.log(
    `[rag:pipeline] spawn-embed done: ${results.length} doc(s) in ${Math.round(performance.now() - t0)}ms`,
  );
  onEvent({ type: "done", results });
  return { results };
}

// Embed a hand-picked set of already-stored documents into the ACTIVE config —
// the workbench's "user library" flow (re-use an upload, no re-upload). Mirrors
// ingest(): a synced config's additions also join its corpus. Docs without
// stored text are silently filtered by documentsForEmbedding. Must run inside
// withConfig(...); streams the same IngestEvents as ingest().
export async function embedDocumentsById(
  docIds: string[],
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const cfg = activeConfig();
  const docs = await documentsForEmbedding(docIds);
  console.log(
    `[rag:pipeline] library-embed ${docs.length}/${docIds.length} doc(s) into config=${cfg.id.slice(0, 8)}`,
  );
  if (cfg.corpusId && cfg.corpusSync) {
    for (const d of docs) await addDocumentToCorpus(cfg.corpusId, d.id);
  }
  onEvent({ type: "start", total: docs.length });
  const results = await embedStoredDocs(docs, onEvent);
  onEvent({ type: "done", results });
  return { results };
}

// Back-compat entry for the populate route's no-body default: embed the active
// config's OWN corpus. A detached config (corpus_id null) has nothing to spawn.
export async function embedExistingCorpus(
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const cfg = activeConfig();
  if (!cfg.corpusId) {
    onEvent({ type: "start", total: 0 });
    onEvent({ type: "done", results: [] });
    return { results: [] };
  }
  return embedCorpora([cfg.corpusId], onEvent);
}

// Corpus auto-sync, add direction: embed newly-added corpus documents into
// every config synced to the corpus (corpus_id set + corpus_sync on). One
// progress stream covers all (config × doc) embeds; file names are decorated
// with the receiving config's label so the user sees where the cost goes.
export async function syncDocsIntoConfigs(
  corpusId: string,
  docIds: string[],
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const configIds = await listSyncedConfigIds(corpusId);
  const docs = await documentsForEmbedding(docIds);
  onEvent({ type: "start", total: configIds.length * docs.length });

  const results: IngestResult[] = [];
  let offset = 0;
  for (const configId of configIds) {
    const resolved = await resolveConfig(configId);
    if (!resolved) continue;
    const summary = await getConfig(configId);
    const label = summary?.label ?? configId.slice(0, 8);
    const batch = await withConfig(resolved, () =>
      embedStoredDocs(docs, onEvent, offset, (name) => `${name} → ${label}`),
    );
    results.push(...batch);
    offset += docs.length;
  }
  onEvent({ type: "done", results });
  return { results };
}

// Add documents to a corpus from the corpus detail page: freshly-loaded
// uploads (stored with raw text, de-duped globally by content hash) and/or
// existing global documents by id. Membership is written first, then the docs
// are sync-embedded into every auto-synced config (one progress stream). No
// active config needed — this is a corpus-level operation.
export async function addDocsToCorpus(
  corpusId: string,
  loaded: SourceDocument[],
  existingDocIds: string[],
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const docIds = [...existingDocIds];
  for (const doc of loaded) {
    const hash = sha256(doc.text);
    const existing = await findDocumentByHash(hash);
    const id = existing?.id ?? (await insertDocument(doc.metadata.fileName, hash, doc.text));
    docIds.push(id);
  }
  for (const id of docIds) await addDocumentToCorpus(corpusId, id);
  return syncDocsIntoConfigs(corpusId, docIds, onEvent);
}

// Corpus auto-sync, remove direction: drop each synced config's embedding of
// the document (chunks/eval labels/overrides go with it — see
// deleteEmbeddingRunFor). The document itself and unsynced configs are
// untouched. Returns how many configs actually held an embedding.
export async function syncRemoveDocFromConfigs(
  corpusId: string,
  documentId: string,
): Promise<number> {
  const configIds = await listSyncedConfigIds(corpusId);
  let removed = 0;
  for (const configId of configIds) {
    const resolved = await resolveConfig(configId);
    if (!resolved) continue;
    if (await deleteEmbeddingRunFor(resolved, documentId)) removed += 1;
  }
  return removed;
}

// Query flow entry: answer a user question. A semantic-cache hit — a past
// question close enough in embedding space (docs/semantic-caching-plan.md) —
// short-circuits retrieval entirely; a miss runs the normal pipeline and banks
// the result for next time. The cache is transparent: with it disabled (or its
// table not yet migrated) this behaves exactly as before.
export async function ask(
  question: string,
): Promise<{ answer: string; sources: RetrievedChunk[] }> {
  const trimmed = question.trim();

  // Disabled, or nothing to match on → original path unchanged (retrieve() also
  // owns the empty-question error, so behaviour is byte-for-byte the same).
  if (!config.semanticCache.enabled || !trimmed) {
    const sources = await retrieve(question);
    return { answer: describeRetrieval(sources), sources };
  }

  const probe = await semanticCacheLookup(trimmed);
  if (probe.hit) return probe.result;

  // Reuse the vector the cache already embedded (banked in embedding_cache) so a
  // miss doesn't pay to embed the query a second time.
  const sources = await retrieveForQuery(trimmed, probe.vector);
  const result = { answer: describeRetrieval(sources), sources };
  await semanticCacheStore(trimmed, probe.vector, result);
  return result;
}

// The placeholder answer while generation is disabled in this branch. When the
// generation work lands, this becomes generateAnswer(...) — the cache stores
// whatever ask() returns, so the caching layer needs no change then.
function describeRetrieval(sources: RetrievedChunk[]): string {
  return `Retrieved ${sources.length} chunk${sources.length === 1 ? "" : "s"}. Generation is disabled — expand "sources" to inspect retrieval.`;
}
