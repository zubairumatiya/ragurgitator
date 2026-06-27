// ---------------------------------------------------------------------------
// API route: GET /api/eval
//
// Returns the current eval summary (Recall@k, per-document breakdown, the
// per-question detail table, and the run snapshots) for the /eval page.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { getSummary } from "@/lib/rag/evalStore";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const summary = await getSummary();
      return Response.json(summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load evals.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
