// ---------------------------------------------------------------------------
// BATCH JOB: ingest_embedding (Voyage) — the embedding leg (−33%).
//
// The many-request batch shape: one Voyage embedding request per chunk. build()
// resolves the documents to embed (an explicit set, a corpus selection, or the
// config's own corpus), chunks each one, and emits a request per chunk keyed
// `<docId>:<position>`. apply() RE-CHUNKS each document (deterministic — same
// chunker, same config scope → same positions/texts, so no chunk text needs to
// survive in the job's jsonb `input`), maps each position back to its returned
// vector, and writes a complete embedding run.
//
// apply is IDEMPOTENT and all-or-nothing per document: it skips a doc that's
// already embedded (hasEmbeddingRun — a re-poll or a competing inline embed) and
// inserts only when EVERY chunk got a vector (a partial run would leave the doc
// mis-retrievable). Voyage-only: batch embedding goes through the Voyage adapter,
// so a config whose base model isn't Voyage returns null (falls back to inline).
// ---------------------------------------------------------------------------
import { activeConfig } from "@/lib/rag/activeConfig";
import { chunkDocument } from "@/lib/rag/chunker";
import { topUpSavedRuns } from "@/lib/rag/clusterStore";
import { dedupCorporaDocuments, documentsForEmbedding } from "@/lib/rag/corpusStore";
import { modelSpec } from "@/lib/rag/embeddingModels";
import { hasEmbeddingRun, insertEmbeddingRunWithChunks } from "@/lib/rag/vectorStore";
import { bankVoyageBatchSaving } from "@/lib/batch/savings";
import type { BatchRequest, BatchResultRow } from "@/lib/batch/types";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";
import type { SourceDocument } from "@/types/rag";

export type IngestEmbeddingScope = { corpusIds?: string[]; documentIds?: string[] };

// Only the document ids need to survive to apply — the chunks (texts + positions)
// are re-derived deterministically, and the model picks the physical table.
type IngestEmbeddingInput = { embeddingModel: string; documentIds: string[] };

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
  provider: "voyage",

  async build(scope) {
    const cfg = activeConfig();
    const spec = modelSpec(cfg.embeddingModel);
    // Batch embedding routes through the Voyage adapter — only a Voyage base
    // model can be batched. Anything else falls back to the inline path.
    if (spec.provider !== "voyage") return null;

    const docIds = await resolveDocIds(scope as IngestEmbeddingScope);
    if (docIds.length === 0) return null;

    const docs = await documentsForEmbedding(docIds);
    const requests: BatchRequest[] = [];
    const included: string[] = [];
    for (const d of docs) {
      if (await hasEmbeddingRun(d.id)) continue; // already embedded under this config
      const chunks = await chunkDocument(toSourceDoc(d));
      if (chunks.length === 0) continue;
      included.push(d.id);
      for (const c of chunks) {
        // Voyage batch: model/input_type/dims live at the batch level (submitMeta);
        // each request body just carries its single text.
        requests.push({ customId: chunkCustomId(d.id, c.position), params: { input: [c.text] } });
      }
    }
    if (requests.length === 0) return null;

    const input: IngestEmbeddingInput = {
      embeddingModel: cfg.embeddingModel,
      documentIds: included,
    };
    return {
      requests,
      input,
      submitMeta: {
        model: spec.apiModel,
        inputType: "document",
        outputDimension: spec.dimension,
      },
    } satisfies BuiltBatch;
  },

  async apply(input, results) {
    const { embeddingModel, documentIds } = input as IngestEmbeddingInput;
    const byId = new Map<string, BatchResultRow>(results.map((r) => [r.customId, r]));
    let embeddedChunks = 0;
    const bankedTexts: string[] = [];

    for (const documentId of documentIds) {
      if (await hasEmbeddingRun(documentId)) continue; // idempotency
      const [d] = await documentsForEmbedding([documentId]);
      if (!d) continue; // stored text gone
      const chunks = await chunkDocument(toSourceDoc(d));
      if (chunks.length === 0) continue;

      // Require every chunk to have a vector — a partial run is worse than none.
      const inserts: { position: number; text: string; embedding: number[] }[] = [];
      let complete = true;
      for (const c of chunks) {
        const res = byId.get(chunkCustomId(documentId, c.position));
        const body = res?.outcome === "succeeded" ? (res.body as VoyageBody) : null;
        const embedding = body?.[0]?.embedding;
        if (!embedding) {
          complete = false;
          break;
        }
        inserts.push({ position: c.position, text: c.text, embedding });
      }
      if (!complete) continue;

      const chunkIds = await insertEmbeddingRunWithChunks({ documentId, chunks: inserts });
      // Same post-insert invariant as the inline embed paths (pipeline.ts, 0033):
      // top up saved cluster runs with the newly ingested chunks.
      await topUpSavedRuns(chunkIds);
      embeddedChunks += inserts.length;
      for (const ins of inserts) bankedTexts.push(ins.text);
    }

    bankVoyageBatchSaving(bankedTexts, embeddingModel);
    return embeddedChunks;
  },
};
