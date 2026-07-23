// ---------------------------------------------------------------------------
// API route: GET /api/semantic-cache/shadow/calibration?space=…
//
// Runs the precision-at-threshold sweep over a space's judged shadow events and
// returns the acceptance-vs-sim curve + the recommended threshold. Backs the
// calibration chart and "Apply calibrated threshold" on Appraise → Semantic
// caching. Global (per vector-space).
// ---------------------------------------------------------------------------
import { calibrationCurve } from "@/lib/rag/semanticCacheCalibration";

export async function GET(request: Request) {
  const space = new URL(request.url).searchParams.get("space");
  if (!space) return Response.json({ error: "space is required." }, { status: 400 });
  try {
    return Response.json({ report: await calibrationCurve(space) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute calibration.";
    return Response.json({ error: message }, { status: 500 });
  }
}
