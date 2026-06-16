// ---------------------------------------------------------------------------
// API route: GET /api/clusters/[id]/buckets/[clusterId]
//
// All chunks in one bucket, nearest-to-centroid first — the indexed bucket
// lookup (chunk_clusters (cluster_id, similarity desc)). `params` is a Promise
// in this Next.js version — await it. (id is part of the path for nesting; the
// lookup is by clusterId.)
// ---------------------------------------------------------------------------
import { getBucketChunks } from "@/lib/rag/clusterStore";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; clusterId: string }> },
) {
  const { clusterId } = await params;
  try {
    const chunks = await getBucketChunks(clusterId);
    return Response.json({ chunks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load bucket.";
    return Response.json({ error: message }, { status: 500 });
  }
}
