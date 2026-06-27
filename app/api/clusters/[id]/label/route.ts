// ---------------------------------------------------------------------------
// API route: POST /api/clusters/[id]/label
//
// The Claude-naming step: label each bucket of a run from its representative
// chunks (lib/rag/clusterLabeler), persist the labels, and return the updated
// run detail so the UI can render them. Surfaced on saved presets only.
// `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { labelBuckets } from "@/lib/rag/clusterLabeler";
import {
  getRun,
  representativeChunksForRun,
  saveClusterLabels,
} from "@/lib/rag/clusterStore";

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
