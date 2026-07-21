// ---------------------------------------------------------------------------
// BATCH JOB: cluster_labeling (Anthropic).
//
// The single-request batch shape — labelBuckets already packs every bucket into
// one prompt, so this batch has exactly one request (custom_id = runId). Shares
// prompt + parse with the inline labeler via labelRequestParams /
// parseBucketLabels (lib/rag/clusterLabeler.ts).
//
// apply is naturally idempotent: saveClusterLabels just UPDATEs clusters.label,
// so re-applying the same labels is a no-op.
// ---------------------------------------------------------------------------
import { activeConfig } from "@/lib/rag/activeConfig";
import { labelRequestParams, parseBucketLabels, type BucketSamples } from "@/lib/rag/clusterLabeler";
import { representativeChunksForRun, saveClusterLabels } from "@/lib/rag/clusterStore";
import type { BuiltBatch, JobHandler } from "@/lib/batch/jobs/registry";

export type ClusterLabelScope = { runId: string };

// Only the ordinals are needed to re-parse (parseBucketLabels' asked-set); the
// chunk texts don't need to survive into apply.
type ClusterLabelInput = { runId: string; ordinals: number[] };

type MessageBody = { content: Array<{ type: string; text?: string }> };

export const clusterLabelingHandler: JobHandler = {
  provider: "anthropic",

  async build(scope) {
    const { runId } = scope as ClusterLabelScope;
    if (!runId) return null;
    const buckets = await representativeChunksForRun(runId);
    if (buckets.length === 0) return null;

    const requests = [
      { customId: runId, params: labelRequestParams(buckets, activeConfig().llmModel) },
    ];
    const input: ClusterLabelInput = { runId, ordinals: buckets.map((b) => b.ordinal) };
    return { requests, input, submitMeta: {} } satisfies BuiltBatch;
  },

  async apply(input, results) {
    const { runId, ordinals } = input as ClusterLabelInput;
    const res = results.find((r) => r.customId === runId);
    if (!res || res.outcome !== "succeeded" || !res.body) return 0;
    // parseBucketLabels only reads each bucket's `ordinal` — rebuild that asked-set.
    const asked: BucketSamples[] = ordinals.map((ordinal) => ({ ordinal, chunks: [] }));
    const labels = parseBucketLabels(res.body as MessageBody, asked);
    if (labels.length === 0) return 0;
    await saveClusterLabels(runId, labels);
    return labels.length;
  },
};
