// ---------------------------------------------------------------------------
// API route: POST /api/clusters/run
//
// Run k-means over the active corpus at the requested k. Produces several random
// restarts (candidates) the user can compare and keep; prior unsaved candidates
// are pruned first (see lib/rag/clusterStore.runClustering). Streams progress as
// NDJSON (one ClusterEvent per line) so the dashboard shows a live bar.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { ndjsonStream } from "@/lib/http/ndjson";
import { withRequestConfig } from "@/lib/http/configScope";
import { corpusSize, runClustering, type ClusterEvent } from "@/lib/rag/clusterStore";

const Body = z.object({
  k: z
    .number({ error: "Provide an integer `k`." })
    .int({ error: "`k` must be an integer." })
    .min(2, { error: "`k` must be at least 2." })
    .max(100, { error: "`k` must be at most 100." }),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const { k } = body.data;

  return withRequestConfig(request, async () => {
    // The chunk-count-dependent bound can't live in the schema; check it here so a
    // too-large k is a clean 400 rather than a stream error.
    const size = await corpusSize();
    if (size === 0) {
      return Response.json(
        { error: "No corpus yet — ingest and process a document first." },
        { status: 400 },
      );
    }
    if (k > size) {
      return Response.json(
        { error: `k=${k} exceeds the ${size} chunks in the corpus.` },
        { status: 400 },
      );
    }

    return ndjsonStream<ClusterEvent>(async (send) => {
      try {
        await runClustering(k, send);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Clustering failed.";
        send({ type: "error", message });
      }
    });
  });
}
