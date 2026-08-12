// BATCH JOB: ingest_embedding (Voyage) — the embedding leg (−33%).
//
// One Voyage embedding request per chunk. build() resolves the documents to embed,
// chunks each one, and emits a request per chunk keyed `<docId>:<position>`.
// apply() RE-CHUNKS each document (deterministic — same chunker, same config scope →
// same positions/texts, so no chunk text needs to survive in the job's jsonb
// `input`), maps each position back to its returned vector, and writes a complete
// embedding run.
//
// BOTH HALVES GO THROUGH THE EMBEDDING CACHE, and it has to be both or the two ways
// of ingesting a document would disagree. build() withholds chunks the user already
// owns; apply() resolves those from the cache and banks what the batch DID buy, so
// a batch-ingested document is as free to delete and re-upload as an inline one.
//
// apply is IDEMPOTENT and all-or-nothing per document: it skips a doc that's already
// embedded and inserts only when EVERY chunk got a vector (a partial run would leave
// the doc mis-retrievable). Voyage-only, so a config whose base model isn't Voyage
// returns null and falls back to inline.
import { activeConfig } from "@/lib/rag/activeConfig";
import { chunkDocument } from "@/lib/rag/chunker";
import { topUpSavedRuns } from "@/lib/rag/clusterStore";
import { dedupCorporaDocuments, documentsForEmbedding } from "@/lib/rag/corpusStore";
import { bankDocVectors, cachedDocVectors, meterEmbeds } from "@/lib/rag/embedCache";
import { modelSpec } from "@/lib/rag/embeddingModels";
import { hasEmbeddingRun, insertEmbeddingRunWithChunks } from "@/lib/rag/vectorStore";
import { bankVoyageBatchSaving } from "@/lib/batch/savings";
import type { BatchRequest, BatchResultRow } from "@/lib/batch/types";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";
import type { SourceDocument } from "@/types/rag";

export type IngestEmbeddingScope = { corpusIds?: string[]; documentIds?: string[] };

// The chunk TEXTS don't need to survive to apply — they're re-derived
// deterministically. But "deterministically" only holds against the settings build()
// used, and this batch is async (hours), so the config can be edited while it's in
// flight. Hence the SNAPSHOT: apply() re-chunks with these, not with whatever
// activeConfig() says by then. Without it, a changed chunk size/overlap silently
// skips every doc (positions stop matching → complete = false → applied: 0, no
// error), and a changed embedding model is worse — the old-space vectors get written
// under the new model's name.
//
// chunkSize/chunkOverlap/dimension are OPTIONAL for backward compatibility: jobs
// enqueued before this field existed have no snapshot and fall back to the live
// config.
type IngestEmbeddingInput = {
  embeddingModel: string;
  documentIds: string[];
  chunkSize?: number;
  chunkOverlap?: number;
  dimension?: number;
};

// Voyage result body (parseVoyageResults): the response's data array. One text
// per request → one embedding.
type VoyageBody = { embedding?: number[] }[];

const chunkCustomId = (docId: string, position: number): string => `${docId}:${position}`;

const toSourceDoc = (d: { id: string; fileName: string; content: string }): SourceDocument => ({
  id: d.id,
  text: d.content,
  metadata: { fileName: d.fileName },
});

// Which documents this batch should embed: an explicit id set wins; else a corpus
// selection (or the active config's own corpus) resolved to its de-duped docs.
async function resolveDocIds(scope: IngestEmbeddingScope): Promise<string[]> {
  if (scope.documentIds && scope.documentIds.length > 0) return scope.documentIds;
  const cfg = activeConfig();
  const corpusIds =
    scope.corpusIds && scope.corpusIds.length > 0
      ? scope.corpusIds
      : cfg.corpusId
        ? [cfg.corpusId]
        : [];
  if (corpusIds.length === 0) return [];
  const { docs } = await dedupCorporaDocuments(corpusIds);
  return docs.map((d) => d.id);
}

export const ingestEmbeddingHandler: JobHandler = {
  async build(scope) {
    const cfg = activeConfig();
    const spec = modelSpec(cfg.embeddingModel);
    // Batch embedding routes through the Voyage adapter — only a Voyage base
    // model can be batched. Anything else falls back to the inline path.
    if (spec.provider !== "voyage") return null;

    const docIds = await resolveDocIds(scope as IngestEmbeddingScope);
    if (docIds.length === 0) return null;

    // The settings this batch is chunked under, snapshotted into `input` below
    // and passed explicitly here so build() and apply() demonstrably agree.
    const snapshot = {
      embeddingModel: cfg.embeddingModel,
      chunkSize: cfg.chunkSize,
      chunkOverlap: cfg.chunkOverlap,
    };

    const docs = await documentsForEmbedding(docIds);
    const requests: BatchRequest[] = [];
    const included: string[] = [];
    for (const d of docs) {
      // Already embedded under this config — nothing to batch. (No saving is
      // banked here: the ingest_skip lever was retired in migrations/0054.)
      if (await hasEmbeddingRun(d.id)) continue;
      const chunks = await chunkDocument(toSourceDoc(d), snapshot);
      if (chunks.length === 0) continue;

      // The cache the inline paths read (lib/rag/embedCache): a chunk this user
      // has already paid to embed under this model is ours, and batching a
      // request for it is still buying it — at 67% of the price, but the whole
      // chunk was free. Checked at BUILD time so those texts never reach the
      // provider at all; apply() re-reads the cache for them.
      const texts = chunks.map((c) => c.text);
      const cached = await cachedDocVectors(texts, cfg.embeddingModel);

      // Wholly cached: there is nothing to batch, so write the run here rather
      // than submit an empty document and wait hours for it. The saving is the
      // avoided embed, priced exactly as the inline path prices it.
      if (chunks.every((c) => cached.has(c.text))) {
        const chunkIds = await insertEmbeddingRunWithChunks({
          documentId: d.id,
          chunks: chunks.map((c) => ({
            position: c.position,
            text: c.text,
            embedding: cached.get(c.text)!,
          })),
        });
        await topUpSavedRuns(chunkIds);
        await meterEmbeds(cfg.embeddingModel, texts, []);
        continue;
      }

      included.push(d.id);
      for (const c of chunks) {
        if (cached.has(c.text)) continue; // already ours — apply() takes it from the cache
        // Voyage batch: model/input_type/dims live at the batch level (submitMeta);
        // each request body just carries its single text.
        requests.push({ customId: chunkCustomId(d.id, c.position), params: { input: [c.text] } });
      }
    }
    if (requests.length === 0) return null;

    const input: IngestEmbeddingInput = {
      ...snapshot,
      documentIds: included,
      // Completes the snapshot: dimension isn't a chunking input, but apply()
      // needs it to resolve the physical table these vectors belong in.
      dimension: cfg.dimension,
    };
    return {
      requests,
      // Unconditional, unlike the LLM jobs: the guard above already returned
      // null for every non-Voyage base model, so reaching here IS the Voyage leg.
      provider: "voyage",
      input,
      submitMeta: {
        model: spec.apiModel,
        inputType: "document",
        outputDimension: spec.dimension,
      },
    } satisfies BuiltBatch;
  },

  async apply(input, results) {
    const { embeddingModel, documentIds, chunkSize, chunkOverlap, dimension } =
      input as IngestEmbeddingInput;
    const cfg = activeConfig();

    // Resolve the settings these vectors were actually produced under. A job
    // predating the snapshot has none, so it falls back to the live config —
    // the old behavior, no worse than before.
    const snapshot = {
      embeddingModel,
      chunkSize: chunkSize ?? cfg.chunkSize,
      chunkOverlap: chunkOverlap ?? cfg.chunkOverlap,
      dimension: dimension ?? cfg.dimension,
    };

    // The one inconsistency re-chunking CANNOT reconcile: if the snapshot's
    // dimension doesn't belong to the snapshot's model, we can't tell which
    // space these vectors are in, and writing them anywhere would corrupt
    // retrieval silently. Fail the job loudly instead. In practice the snapshot
    // is internally consistent (both fields come from one config read at
    // build()), so this only trips on a genuinely malformed job record.
    const specDimension = modelSpec(snapshot.embeddingModel).dimension;
    if (snapshot.dimension !== specDimension) {
      throw new Error(
        `ingest_embedding: snapshot is inconsistent — model "${snapshot.embeddingModel}" ` +
          `is ${specDimension}-dimensional but the job recorded ${snapshot.dimension}. ` +
          `Refusing to write vectors whose space can't be determined.`,
      );
    }

    if (
      snapshot.embeddingModel !== cfg.embeddingModel ||
      snapshot.chunkSize !== cfg.chunkSize ||
      snapshot.chunkOverlap !== cfg.chunkOverlap
    ) {
      console.warn(
        `[batch:ingest_embedding] config changed while this batch was in flight — ` +
          `applying under the SNAPSHOT (model=${snapshot.embeddingModel}, ` +
          `size=${snapshot.chunkSize}, overlap=${snapshot.chunkOverlap}); ` +
          `live config is (model=${cfg.embeddingModel}, size=${cfg.chunkSize}, ` +
          `overlap=${cfg.chunkOverlap}). These vectors belong to the snapshot's space.`,
      );
    }

    const byId = new Map<string, BatchResultRow>(results.map((r) => [r.customId, r]));
    let embeddedChunks = 0;
    // Split by provenance, because the two are priced differently: `boughtTexts`
    // went to the batch API and saved the −33% off the sync price; `cachedTexts`
    // were already ours and saved the whole embed. Only the bought ones are
    // banked INTO the cache — the cached ones are where they came from.
    const boughtTexts: string[] = [];
    const cachedTexts: string[] = [];
    const toBank: { text: string; vector: number[] }[] = [];

    for (const documentId of documentIds) {
      // Idempotency, NOT a saving: this skip means a re-poll or a racing inline
      // embed already landed the run. The avoided embed (if any) was banked at
      // submit; banking here too would double-count our own retry.
      if (await hasEmbeddingRun(documentId)) continue;
      const [d] = await documentsForEmbedding([documentId]);
      if (!d) continue; // stored text gone
      const chunks = await chunkDocument(toSourceDoc(d), snapshot);
      if (chunks.length === 0) continue;

      // build() withheld the chunks it already owned from the batch, so a chunk
      // with no result row is not automatically a failure — look it up before
      // deciding. Under the snapshot's model, since that is the space these
      // vectors are in.
      const cached = await cachedDocVectors(
        chunks.map((c) => c.text),
        snapshot.embeddingModel,
      );

      // Require every chunk to have a vector — a partial run is worse than none.
      const inserts: { position: number; text: string; embedding: number[] }[] = [];
      const bought: { text: string; vector: number[] }[] = [];
      const fromCache: string[] = [];
      let complete = true;
      for (const c of chunks) {
        const res = byId.get(chunkCustomId(documentId, c.position));
        const body = res?.outcome === "succeeded" ? (res.body as VoyageBody) : null;
        const returned = body?.[0]?.embedding;
        const embedding = returned ?? cached.get(c.text);
        if (!embedding) {
          complete = false;
          break;
        }
        if (returned) bought.push({ text: c.text, vector: returned });
        else fromCache.push(c.text);
        inserts.push({ position: c.position, text: c.text, embedding });
      }
      if (!complete) continue;

      // Label the run with the SNAPSHOT, not the live config: these vectors were
      // produced under it, and it also picks the physical chunks table.
      const chunkIds = await insertEmbeddingRunWithChunks({
        documentId,
        chunks: inserts,
        settings: snapshot,
      });
      // Same post-insert invariant as the inline embed paths (pipeline.ts, 0033):
      // top up saved cluster runs with the newly ingested chunks.
      await topUpSavedRuns(chunkIds);
      embeddedChunks += inserts.length;
      // After the insert, not before: a document whose run didn't land banked
      // nothing, exactly as it banked no batch saving.
      toBank.push(...bought);
      for (const b of bought) boughtTexts.push(b.text);
      cachedTexts.push(...fromCache);
    }

    // Into the cache, so a batch-ingested document is as free to delete and
    // re-upload as an inline-ingested one. Best-effort inside (embedCache), so
    // this can't fail an applied batch.
    await bankDocVectors(toBank, embeddingModel);
    await bankVoyageBatchSaving(boughtTexts, embeddingModel);
    await meterEmbeds(embeddingModel, cachedTexts, []);
    return embeddedChunks;
  },
};
