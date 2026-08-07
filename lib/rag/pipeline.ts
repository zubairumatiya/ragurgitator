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

import { submitIngestBatchIfEnabled } from "@/lib/batch/ingestLever";
import { cheapModelFor, config } from "@/lib/config";
import { detached } from "@/lib/detached";
import type { StreamErrorEvent } from "@/lib/http/missingKey";
import { activeConfig, resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { chunkDocument } from "@/lib/rag/chunker";
import {
  responseEfficacyGate,
  retrievalFloor,
} from "@/lib/rag/efficacyGate";
import { generateAnswer, type GeneratedAnswer } from "@/lib/rag/generator";
import { costEmbed, costLlm, estimateTokens } from "@/lib/rag/pricing";
import { recordSaving } from "@/lib/rag/savingsStore";
import {
  addDocumentToCorpus,
  dedupCorporaDocuments,
  documentsForEmbedding,
  type EmbeddableDoc,
} from "@/lib/rag/corpusStore";
import { topUpSavedRuns } from "@/lib/rag/clusterStore";
import { getConfig, listSyncedConfigIds } from "@/lib/rag/configStore";
import { embedDocsCached } from "@/lib/rag/embedCache";
import { labelFor, loadDocument, type LoadInput } from "@/lib/rag/loader";
import { getActiveBatchSavings } from "@/lib/rag/batchStore";
import { retrieve, retrieveForQuery } from "@/lib/rag/retriever";
import {
  semanticCacheLookup,
  semanticCacheStore,
  type CachedResult,
} from "@/lib/rag/semanticCache";
import {
  deleteEmbeddingRunFor,
  embeddingRunChunkCounts,
  findDocumentByHash,
  insertDocument,
  insertEmbeddingRunWithChunks,
} from "@/lib/rag/vectorStore";
import type { RetrievedChunk, SourceDocument } from "@/types/rag";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Ingestion stages, in order. The UI mirrors these as a step indicator.
export type IngestStep = "load" | "chunk" | "embed" | "store";

// The half of an upload that has to happen before any vector exists: dedup by
// content hash, store the raw text, join the config's corpus when it's synced.
// Returns the document id.
//
// SPLIT FROM THE EMBED HALF so the batch lever can be offered a document id —
// an ingest_embedding batch is scoped to ids, so nothing can be embedded until
// every input in the upload has one. See ingest().
async function storeOne(doc: SourceDocument): Promise<string> {
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

  return documentId;
}

// The embed half: chunk → embed → store a run for `documentId` under the active
// config. Returns the number of chunks added (0 when the config already has it).
async function embedOne(
  documentId: string,
  doc: SourceDocument,
  onStep: (step: IngestStep) => void = () => {},
): Promise<number> {
  const cfg = activeConfig();

  // A run already exists — nothing to buy. Returns the RUN'S OWN chunk count,
  // not zero, because the callers here have already filtered out the documents
  // that were embedded before they started (see ingest()). What's left is a run
  // that landed during this operation: the batch builder writes one outright
  // when the embedding cache covers the whole document, and calling that "no new
  // chunks" would deny work that just happened.
  //
  // This used to bank the ingest_skip lever; it doesn't any more
  // (migrations/0054) — the avoided embed worth counting is the cache's, and
  // embedDocsCached banks it below as embed_cache.
  const existingRun = (await embeddingRunChunkCounts([documentId])).get(documentId);
  if (existingRun !== undefined) {
    console.log(
      `[rag:pipeline] skip embed: ${doc.metadata.fileName} already embedded under ` +
        `config=${cfg.id.slice(0, 8)} (${cfg.embeddingModel} size=${cfg.chunkSize} overlap=${cfg.chunkOverlap})`,
    );
    return existingRun;
  }

  onStep("chunk");
  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) return 0;

  onStep("embed");
  const chunkTexts = chunks.map((c) => c.text);
  // Through the per-user embedding cache, not straight at the provider. A chunk
  // this user has already paid to embed under this model is free however it got
  // there: another config ingested it, or this very document did before it was
  // deleted — the cache outlives the document (lib/rag/embedCache). Content
  // addressing makes that safe with no invalidation to get wrong, since the key
  // is sha256(text) under a model id.
  //
  // embedDocsCached meters itself — hits as embed_cache, misses as embed spend —
  // so there is no meterEmbeds call here; a second one would double-count.
  const vectors = await embedDocsCached(chunkTexts, cfg.embeddingModel);

  onStep("store");
  const chunkIds = await insertEmbeddingRunWithChunks({
    documentId,
    chunks: chunks.map((c, i) => ({
      position: c.position,
      text: c.text,
      embedding: vectors[i],
    })),
  });
  await topUpSavedRuns(chunkIds);

  return chunks.length;
}

// One entry per input source: a chunk count on success, an error string on
// failure. A single bad file no longer sinks the whole batch.
//
// `queued` is the third outcome and it is neither of the other two: the document
// is stored and its embeddings are with the batch API, so there are no chunks
// yet and nothing went wrong. Reporting it as `chunksAdded: 0` would read as
// "nothing happened" for work that will land hours later.
export type IngestResult =
  | { fileName: string; chunksAdded: number }
  | { fileName: string; queued: true }
  | { fileName: string; error: string };

// Progress events streamed to the client during ingestion. The route serializes
// these as NDJSON; the UI turns them into a progress bar + step indicator.
export type IngestEvent =
  | { type: "start"; total: number }
  | { type: "step"; index: number; fileName: string; step: IngestStep }
  | { type: "file-done"; index: number; result: IngestResult }
  | { type: "done"; results: IngestResult[] }
  // The shared stream error shape — carries the missing-provider-key fields
  // when that was the cause, so every stream reports it the same way the
  // plain routes do. See lib/http/missingKey.ts.
  | StreamErrorEvent;

type Emit = (event: IngestEvent) => void;

// Sequential on purpose: ordered step events make for a clean progress UI, and
// it keeps us from firing every file's embeddings at the provider at once.
//
// THREE PHASES, and the middle one is why the first two are separate. Load and
// store every input, THEN offer the whole document set to the embedding leg's
// batch preference, THEN embed inline whatever the batch didn't take. An
// ingest_embedding batch is scoped to document ids, so it cannot be offered
// anything until every input has been stored — which is the only reason storing
// and embedding are no longer one pass per file.
export async function ingest(
  inputs: LoadInput[],
  onEvent: Emit = () => {},
): Promise<{ results: IngestResult[] }> {
  const t0 = performance.now();
  console.log(`[rag:pipeline] ingest start (${inputs.length} source(s))`);
  onEvent({ type: "start", total: inputs.length });

  // Indexed rather than pushed, so a file that fails to load in phase 1 still
  // reports in its own position rather than ahead of files that loaded fine.
  const byIndex: (IngestResult | undefined)[] = new Array(inputs.length);
  const done = (index: number, fileName: string, result: IngestResult) => {
    byIndex[index] = result;
    onEvent({ type: "file-done", index, result });
  };

  // PHASE 1 — load + store.
  const stored: {
    index: number;
    fileName: string;
    documentId: string;
    doc: SourceDocument;
  }[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const fileName = labelFor(inputs[index]);
    try {
      onEvent({ type: "step", index, fileName, step: "load" });
      const doc = await loadDocument(inputs[index]);
      stored.push({ index, fileName, documentId: await storeOne(doc), doc });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Ingestion failed.";
      console.error(`[rag:pipeline] ingest failed for "${fileName}": ${error}`);
      done(index, fileName, { fileName, error });
    }
  }

  // Which of these the config ALREADY held, snapshotted before the batch lever
  // gets a chance to change the answer. Only these can honestly report "no new
  // chunks"; anything embedded from here on was embedded by this ingest, however
  // cheaply. Re-uploading a document the config already has is the one flow that
  // lands here.
  const preEmbedded = new Set(
    (await embeddingRunChunkCounts(stored.map((s) => s.documentId))).keys(),
  );

  // PHASE 2 — the batch lever. True means these documents' vectors are with the
  // provider and will be written by a later /api/batch/poll, so there is nothing
  // to embed here and the progress stream closes; the BatchRequests panel is
  // what tracks them from now on.
  const queued =
    stored.length > 0 &&
    (await submitIngestBatchIfEnabled({ documentIds: stored.map((s) => s.documentId) }));

  // PHASE 3 — inline for whatever is left. Note this also runs when the batch
  // lever is ON but build() found nothing to submit: a document the embedding
  // cache already covers is embedded here, for free, rather than waiting hours
  // to buy vectors we own.
  for (const s of stored) {
    if (queued) {
      done(s.index, s.fileName, { fileName: s.fileName, queued: true });
      continue;
    }
    if (preEmbedded.has(s.documentId)) {
      done(s.index, s.fileName, { fileName: s.fileName, chunksAdded: 0 });
      continue;
    }
    try {
      const chunksAdded = await embedOne(s.documentId, s.doc, (step) =>
        onEvent({ type: "step", index: s.index, fileName: s.fileName, step }),
      );
      done(s.index, s.fileName, { fileName: s.fileName, chunksAdded });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Ingestion failed.";
      console.error(`[rag:pipeline] ingest failed for "${s.fileName}": ${error}`);
      done(s.index, s.fileName, { fileName: s.fileName, error });
    }
  }

  const results = byIndex.filter((r): r is IngestResult => r !== undefined);
  const chunksAdded = results.reduce(
    (sum, r) => sum + ("chunksAdded" in r ? r.chunksAdded : 0),
    0,
  );
  console.log(
    `[rag:pipeline] ingest done: ${queued ? "queued for batch" : `${chunksAdded} chunks`} from ` +
      `${results.length} source(s) in ${Math.round(performance.now() - t0)}ms`,
  );
  onEvent({ type: "done", results });
  return { results };
}

// Core of every "embed stored docs, no re-upload" flow: chunk → embed → store
// each doc (raw text persisted at first ingest, migration 0010) into the ACTIVE
// config; already-embedded docs are no-ops. Emits step/file-done events only —
// the caller owns start/done so several passes can share one progress stream.
//
// `indexOffset` keeps indexes continuous across passes; `fileLabel` decorates
// names (e.g. "doc.md → config-X" during a multi-config sync); `preEmbedded` is
// the set of ids the config held BEFORE the caller started, and it is the only
// thing that can distinguish "already had it" from "just got it" — see
// vectorStore.embeddingRunChunkCounts.
type EmbedStoredOpts = {
  indexOffset?: number;
  fileLabel?: (name: string) => string;
  preEmbedded: Set<string>;
};

async function embedStoredDocs(
  docs: EmbeddableDoc[],
  onEvent: Emit,
  opts: EmbedStoredOpts,
): Promise<IngestResult[]> {
  const indexOffset = opts.indexOffset ?? 0;
  const fileLabel = opts.fileLabel ?? ((name: string) => name);
  const results: IngestResult[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const index = indexOffset + i;
    const fileName = fileLabel(d.fileName);
    let result: IngestResult;
    try {
      const existingRun = (await embeddingRunChunkCounts([d.id])).get(d.id);
      if (existingRun !== undefined) {
        // Zero only when it was already here; otherwise the run landed during
        // this pass (the batch builder writes one straight out of the embedding
        // cache) and its real size is what happened.
        result = {
          fileName,
          chunksAdded: opts.preEmbedded.has(d.id) ? 0 : existingRun,
        };
      } else {
        const doc: SourceDocument = {
          id: d.id,
          text: d.content,
          metadata: { fileName: d.fileName },
        };
        onEvent({ type: "step", index, fileName, step: "chunk" });
        const chunks = await chunkDocument(doc);
        onEvent({ type: "step", index, fileName, step: "embed" });
        const texts = chunks.map((c) => c.text);
        // Cached, and self-metering — same as ingestOne, for the same reasons.
        const vectors = await embedDocsCached(texts, activeConfig().embeddingModel);
        onEvent({ type: "step", index, fileName, step: "store" });
        const chunkIds = await insertEmbeddingRunWithChunks({
          documentId: d.id,
          chunks: chunks.map((c, i2) => ({
            position: c.position,
            text: c.text,
            embedding: vectors[i2],
          })),
        });
        await topUpSavedRuns(chunkIds);
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

// The batch lever, then whatever it didn't take — the stored-doc counterpart of
// ingest()'s phases 2 and 3, so every user-initiated embed honours the config's
// batch preference identically. The snapshot has to be taken HERE, before the
// lever runs: build() can write a run outright for a document the embedding
// cache already covers, and after that there is no way to tell that from a run
// that was there all along.
//
// Auto-sync (syncDocsIntoConfigs) deliberately doesn't come through here. It is
// a side effect of editing a corpus rather than someone asking to embed, and
// deferring it by up to 12 hours per synced config isn't what "sync" means.
async function embedOrQueue(
  docs: EmbeddableDoc[],
  onEvent: Emit,
  opts: { indexOffset?: number; fileLabel?: (name: string) => string } = {},
): Promise<IngestResult[]> {
  const indexOffset = opts.indexOffset ?? 0;
  const fileLabel = opts.fileLabel ?? ((name: string) => name);
  const preEmbedded = new Set(
    (await embeddingRunChunkCounts(docs.map((d) => d.id))).keys(),
  );

  if (
    docs.length > 0 &&
    (await submitIngestBatchIfEnabled({ documentIds: docs.map((d) => d.id) }))
  ) {
    return docs.map((d, i) => {
      const result: IngestResult = { fileName: fileLabel(d.fileName), queued: true };
      onEvent({ type: "file-done", index: indexOffset + i, result });
      return result;
    });
  }

  return embedStoredDocs(docs, onEvent, { indexOffset, fileLabel, preEmbedded });
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
  const results = await embedOrQueue(docs, onEvent);
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
  const results = await embedOrQueue(docs, onEvent);
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
    const batch = await withConfig(resolved, async () =>
      embedStoredDocs(docs, onEvent, {
        indexOffset: offset,
        fileLabel: (name: string) => `${name} → ${label}`,
        // This config's existing runs. Nothing here writes one behind our back
        // (auto-sync doesn't go through the batch lever), so the snapshot is
        // just "what it already had" and the reporting reads as it always did.
        preEmbedded: new Set(
          (await embeddingRunChunkCounts(docs.map((d) => d.id))).keys(),
        ),
      }),
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

// Query flow entry: answer a user question. Two layers wrap the generation
// cascade:
//   1. Semantic cache (docs/semantic-caching-plan.md) — a past question close
//      enough in embedding space serves its banked answer, skipping retrieval AND
//      generation. Whether a close match is actually SERVED is the per-config
//      "Serve cached answers" toggle (Settings → Savings); the cache is POPULATED
//      regardless, so flipping serving on later has data to hit against.
//      Transparent: the mechanism disabled or its table unmigrated → behaves as
//      if absent.
//   2. Generation cascade (answerWithCascade) — the actual answer, cheap-model
//      first with axis-2 escalation when saver mode is on.
export async function ask(question: string): Promise<CachedResult> {
  const trimmed = question.trim();

  // Disabled, or nothing to match on → straight to the cascade (retrieve() also
  // owns the empty-question error, so behaviour is byte-for-byte the same).
  if (!config.semanticCache.enabled || !trimmed) {
    return answerWithCascade(question, await retrieve(question));
  }

  const { serve, threshold, keyModel } = (await getActiveBatchSavings()).semanticCache;
  const probe = await semanticCacheLookup(trimmed, { serve, threshold, keyModel });
  if (probe.hit) return probe.result;

  // Miss (or would-hit with serving off): reuse the vector the cache already
  // embedded (banked in embedding_cache) so we don't pay to embed the query
  // twice, run the cascade, and always bank the result — so the cache fills even
  // while serving is off.
  //
  // `queryVector` is null when the CACHE-KEY model differs from this config's
  // retrieval model (docs/semantic-cache-key-model-plan.md, Phase 1): the key
  // vector is then in a foreign space and useless to the retriever, so retrieve()
  // embeds under the config's own model as it would with no cache at all. The
  // key vector still goes to the store, which banks under the key model.
  const sources = probe.queryVector
    ? await retrieveForQuery(trimmed, probe.queryVector)
    : await retrieve(trimmed);
  const result = await answerWithCascade(question, sources);
  await semanticCacheStore(trimmed, probe.key, result);
  return result;
}

// The FrugalGPT generation cascade over already-retrieved sources: cheap model
// first, escalate to the config's llmModel only on an AXIS-2 failure. Factored
// out of ask() so the semantic-cache miss path can feed it the sources it
// retrieved from the cache's already-embedded vector.
async function answerWithCascade(
  question: string,
  sources: RetrievedChunk[],
): Promise<CachedResult> {
  const cfg = activeConfig();
  const strongModel = cfg.llmModel;

  // Saver mode off (default) → today's behaviour: one answer from the config's
  // model, no gate, no extra cost. Per-config toggle (0032), read from the
  // already-loaded ResolvedConfig — no extra query on the hot path. This is the
  // cascade's BASELINE, so it records no saving (its cost is the chat spend).
  if (!cfg.cascadeEnabled) {
    const gen = await generateAnswer(question, sources, strongModel);
    return {
      answer: gen.answer,
      sources,
      model: strongModel,
      efficacy: null,
      escalated: false,
    };
  }

  // Derived from the strong tier so the cascade never crosses providers — one
  // provider, one key, one rate card for both legs (lib/config.cheapModelFor).
  const cheapModel = cheapModelFor(strongModel);

  // AXIS 1 (rung 1, PRE-generation): weak retrieval is a context bottleneck a
  // stronger model can't fix, so when it fails we answer once with the cheap
  // model and never escalate (docs/long-term-savings-research.md §4.1).
  const contextSufficient =
    retrievalFloor(sources) >= config.cascade.retrievalHardFloor;

  let model: string = cheapModel;
  const cheap = await generateAnswer(question, sources, model);
  let answer = cheap.answer;
  let efficacy = await responseEfficacyGate(question, answer, sources);

  // Escalate only on an AXIS-2 failure (refusal / weak groundedness) AND only
  // when the context was good enough to answer from in the first place.
  const escalated =
    contextSufficient &&
    efficacy.verdict === "escalate" &&
    strongModel !== cheapModel;

  let strong: GeneratedAnswer | null = null;
  if (escalated) {
    model = strongModel;
    strong = await generateAnswer(question, sources, model);
    answer = strong.answer;
    // Re-score so the returned efficacy describes the answer we actually return.
    efficacy = await responseEfficacyGate(question, answer, sources);
  }

  // Record the NET cascade saving vs. the baseline (strong model every time). The
  // efficacy gate embeds the answer once per generation (rung 2) — priced here as
  // the one bit of overhead the cheap-first path adds. docs §2 #2.
  await detached(() =>
    recordCascadeSaving({
      strongModel,
      cheapModel,
      embeddingModel: cfg.embeddingModel,
      cheap,
      strong,
      escalated,
      answer,
    }),
  );

  return { answer, sources, model, efficacy, escalated };
}

// The cascade's saved dollars, honest and signed (docs §2 #2):
//   accept   → we ran cheap instead of strong: saved = cost(strong@cheapTokens)
//              − cost(cheap) − one gate embed.  POSITIVE.
//   escalate → we ran cheap + gate + strong + gate but the baseline is strong
//              ONCE, so the cheap attempt and the extra gate were wasted:
//              saved = −cost(cheap) − two gate embeds.  NEGATIVE.
// The running total over real traffic is therefore the true net.
//
// No try/catch of its own: detached() swallows on both of its paths, which also
// finally covers the costLlm/costEmbed throw on an unpriced model — an unhandled
// rejection back when this was `void`-ed.
async function recordCascadeSaving(a: {
  strongModel: string;
  cheapModel: string;
  embeddingModel: string;
  cheap: GeneratedAnswer;
  strong: GeneratedAnswer | null;
  escalated: boolean;
  answer: string;
}): Promise<void> {
  const gateEmbed = costEmbed(a.embeddingModel, estimateTokens(a.answer));
  if (!a.escalated) {
    const saved =
      costLlm(a.strongModel, a.cheap.inputTokens, a.cheap.outputTokens) -
      costLlm(a.cheapModel, a.cheap.inputTokens, a.cheap.outputTokens) -
      gateEmbed;
    await recordSaving("cascade", saved, a.cheap.inputTokens + a.cheap.outputTokens);
  } else {
    const wasted = costLlm(a.cheapModel, a.cheap.inputTokens, a.cheap.outputTokens);
    await recordSaving("cascade", -(wasted + 2 * gateEmbed), 0);
  }
}
