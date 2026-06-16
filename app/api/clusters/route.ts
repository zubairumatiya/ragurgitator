// ---------------------------------------------------------------------------
// API route: GET /api/clusters
//
// Lists the active model's cluster runs — saved presets first, then the current
// unsaved candidates — as summaries for the dashboard and the compare picker.
// ---------------------------------------------------------------------------
import { listRuns } from "@/lib/rag/clusterStore";

export async function GET() {
  try {
    const runs = await listRuns();
    return Response.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list cluster runs.";
    return Response.json({ error: message }, { status: 500 });
  }
}
