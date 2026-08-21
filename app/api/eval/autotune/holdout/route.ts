// API route: GET /api/eval/autotune/holdout
//
// Every autotune run of the active config that recorded a held-out set (0074),
// newest first, with both sides' rates at both ends.
//
// A SEPARATE ROUTE, not a field on the criteria GET or on /api/eval. This is a
// HISTORY read: it grows with the run count and never changes between summary
// refreshes, while /api/eval is re-fetched after every score, edit, add and
// delete. Folding it in would make the dashboard pay for the whole run history
// on each of those, to render a section that is collapsed by default.
//
// The live split needs no route at all — `summary.questions` already carries
// `heldOut` per row, so today's train/holdout rates are a client-side partition
// of data the dashboard has already fetched (lib/rag/evalRates.ts).
import { withRequestConfig } from "@/lib/http/configScope";
import { listHoldoutRuns } from "@/lib/rag/autotuneStore";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      return Response.json({ runs: await listHoldoutRuns() });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load held-out run history.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
