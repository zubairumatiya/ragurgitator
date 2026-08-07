// ---------------------------------------------------------------------------
// THE EMBEDDING LEG'S BATCH PREFERENCE, in one place.
//
// "Batch the embedding leg" is a per-config savings setting (Settings → Savings),
// and every path that is about to buy ingest embeddings has to honour it or the
// setting is a lie in whichever path forgot. There are two such paths and they
// used to disagree: spawn-from-corpora (POST /api/configs/[id]/populate) checked
// it, and a plain file upload (POST /api/ingest, via lib/rag/pipeline.ingest)
// never did — so a user with the lever on watched uploads embed inline at full
// price. This is the shared answer both of them now ask.
//
// ADDITIVE, never fatal. build() returns null for a non-Voyage base model (only
// Voyage batch-embeds), for nothing to embed, and for a document set the
// embedding cache already covers — in each case this returns false and the
// caller embeds inline, which is the behaviour with the lever off.
//
// Returning TRUE means the work has left the building: the requests are with the
// provider, the job row tracks them, and the documents get their vectors when
// /api/batch/poll applies the results (Voyage: up to 12h). The caller must NOT
// then embed inline — that would buy the same vectors twice.
//
// Must run inside the target config's withConfig scope: the handler reads
// activeConfig() for its settings and the job is filed against that config.
// ---------------------------------------------------------------------------
import { handlerFor } from "@/lib/batch/jobs/registry";
import type { IngestEmbeddingScope } from "@/lib/batch/jobs/ingestEmbedding";
import { submitBatch } from "@/lib/batch/orchestrator";
import { isBatchEnabled } from "@/lib/batch/types";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getActiveBatchSavings } from "@/lib/rag/batchStore";
import { getConfig } from "@/lib/rag/configStore";

export async function submitIngestBatchIfEnabled(
  scope: IngestEmbeddingScope,
): Promise<boolean> {
  const savings = await getActiveBatchSavings();
  if (!isBatchEnabled(savings, "ingest_embedding")) return false;

  const handler = handlerFor("ingest_embedding");
  if (!handler) return false;

  const built = await handler.build(scope);
  if (!built || built.requests.length === 0) return false;

  const cfg = activeConfig();
  const summary = await getConfig(cfg.id);
  await submitBatch({
    kind: "ingest_embedding",
    provider: built.provider,
    configId: cfg.id,
    configLabel: summary?.label ?? "—",
    requests: built.requests,
    input: built.input,
    submitMeta: built.submitMeta,
  });
  return true;
}
