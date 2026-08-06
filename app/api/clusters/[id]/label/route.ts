// ---------------------------------------------------------------------------
// API route: POST /api/clusters/[id]/label
//
// The Claude-naming step: label each bucket of a run from its representative
// chunks (lib/rag/clusterLabeler), persist the labels, and return the updated
// run detail so the UI can render them. Surfaced on saved presets only.
// `params` is a Promise in this Next.js version — await it.
//
// Honors Settings → Savings: when this config picked "Batch API" for cluster
// labeling, submit the run as a batch instead and return { batch } — no labels
// land now; they're written by the handler's apply() when the batch completes.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { labelBuckets } from "@/lib/rag/clusterLabeler";
import {
  getRun,
  representativeChunksForRun,
  saveClusterLabels,
} from "@/lib/rag/clusterStore";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { getActiveBatchSavings } from "@/lib/rag/batchStore";
import { isBatchEnabled } from "@/lib/batch/types";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRequestConfig(request, async () => {
    try {
      const buckets = await representativeChunksForRun(id);
      if (buckets.length === 0) {
        return Response.json({ error: "Run not found or has no chunks." }, { status: 404 });
      }

      // Batch path — additive; the inline path below is untouched and is still
      // the default (batch is opt-in per config).
      const savings = await getActiveBatchSavings();
      if (isBatchEnabled(savings, "cluster_labeling")) {
        const handler = handlerFor("cluster_labeling")!;
        const built = await handler.build({ runId: id });
        // build() re-reads the same buckets we just found non-empty, so this is
        // a belt-and-braces guard rather than an expected outcome.
        if (!built || built.requests.length === 0) {
          return Response.json({ error: "Nothing to label for this run." }, { status: 404 });
        }
        const cfg = await getConfig(activeConfig().id);
        const job = await submitBatch({
          kind: "cluster_labeling",
          provider: built.provider,
          configId: activeConfig().id,
          configLabel: cfg?.label ?? "—",
          requests: built.requests,
          input: built.input,
          submitMeta: built.submitMeta,
        });
        return Response.json({ batch: { jobId: job.id, bucketCount: buckets.length } });
      }

      const labels = await labelBuckets(buckets);
      await saveClusterLabels(id, labels);
      const run = await getRun(id);
      return Response.json(run);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to label buckets.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
