// ---------------------------------------------------------------------------
// API route: POST /api/semantic-cache/collision-floor
//
// Computes the eval-bank collision floor for the ACTIVE config's vector-space
// (config-scoped via withRequestConfig — the client passes ?configId=…) and
// returns the recommendation WITHOUT applying it. Pure arithmetic over already-
// cached query embeddings, so no LLM calls. Backs the Collision floor panel's
// "Compute" button; "Apply recommended" then POSTs /thresholds.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { computeCollisionFloor } from "@/lib/rag/semanticCacheCalibration";

export async function POST(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      return Response.json({ report: await computeCollisionFloor() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to compute collision floor.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
