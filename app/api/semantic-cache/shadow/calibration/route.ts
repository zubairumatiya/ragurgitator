// API route: GET /api/semantic-cache/shadow/calibration?space=…&origin=…
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
//
// `origin` SELECTS A POPULATION, NOT A FILTER ON ONE (0069). The default stays
// 'traffic' — the recommendation this produces is a serving threshold for real
// questions, and that is the only population made of real questions. 'probe' reads
// the WORST-CASE BOUND against engineered near-misses, which is the only population
// with rejects in it and therefore the only one whose curve shows precision trading
// against recall. It is offered because a bound nobody can look at is a bound
// nobody checks; the panel is what keeps it from being mistaken for a setting.
import { withRequestConfig } from "@/lib/http/configScope";
import { scopedAcceptTarget } from "@/lib/rag/semanticCache";
import { calibrationCurve } from "@/lib/rag/semanticCacheCalibration";

const ORIGINS = new Set(["traffic", "probe", "all"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const space = params.get("space");
  if (!space) return Response.json({ error: "space is required." }, { status: 400 });
  // An unknown value falls back to the default rather than 400ing: this is a
  // display dimension, and the report names the origin it actually used, so a
  // stale link renders the safe population and says which one it is.
  const raw = params.get("origin");
  const origin = raw && ORIGINS.has(raw) ? (raw as "traffic" | "probe" | "all") : undefined;
  return withRequestConfig(request, async () => {
    try {
      const report = await calibrationCurve(space, await scopedAcceptTarget(), { origin });
      return Response.json({ report });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to compute calibration.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
