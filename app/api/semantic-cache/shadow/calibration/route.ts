// API route: GET /api/semantic-cache/shadow/calibration?space=…
//
// Runs the precision-at-threshold sweep over a space's judged shadow events and
// returns the acceptance-vs-sim curve + the recommended threshold. Global (per
// vector-space).
//
// Config-scoped ANYWAY, for one value: the PRECISION TARGET the sweep holds itself
// to is a per-config setting. The judged events are per-space and shared; only the
// target is the scoped config's. Note /appraise/semantic-cache is not under
// /c/<configId>, so apiFetch sends no configId and this resolves to the Default
// config — which is exactly why the report carries `targetSource` back out, naming
// the config whose dial was used instead of showing an unattributed percentage.
import { withRequestConfig } from "@/lib/http/configScope";
import { scopedAcceptTarget } from "@/lib/rag/semanticCache";
import { calibrationCurve } from "@/lib/rag/semanticCacheCalibration";

export async function GET(request: Request) {
  const space = new URL(request.url).searchParams.get("space");
  if (!space) return Response.json({ error: "space is required." }, { status: 400 });
  return withRequestConfig(request, async () => {
    try {
      return Response.json({ report: await calibrationCurve(space, await scopedAcceptTarget()) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to compute calibration.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
