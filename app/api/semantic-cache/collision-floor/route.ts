// ---------------------------------------------------------------------------
// API route: GET/POST /api/semantic-cache/collision-floor
//
// Config-scoped via withRequestConfig (the client passes ?configId=…) — the
// floor is derived from ONE config's eval bank, so both verbs are scoped the
// same way.
//
// POST — compute the eval-bank collision floor for the scoped config's vector-
//        space and return the recommendation WITHOUT applying it (applying is
//        the Threshold box's job, POST /thresholds). Pure arithmetic over
//        already-cached query embeddings, so no LLM calls. Also SAVES the report
//        (migration 0037) so the panel survives navigation.
// GET  — the last saved report for the scoped config, or { report: null } when
//        nothing has been computed (or 0037 isn't applied). Also returns the
//        config's live labeled-question count so the panel can tell the user the
//        saved numbers were measured against a different bank.
//
// The save is BEST-EFFORT and deliberately after the fact: a computed report is
// the expensive thing here, and a persistence problem must never turn a
// successful calibration into a 500 (collisionFloorStore swallows its own
// errors, so the await below can't throw).
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import {
  countLabeledQuestions,
  getSavedCollisionFloor,
  saveCollisionFloor,
} from "@/lib/rag/collisionFloorStore";
import { computeCollisionFloor } from "@/lib/rag/semanticCacheCalibration";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const [saved, questionsNow] = await Promise.all([
        getSavedCollisionFloor(),
        countLabeledQuestions(),
      ]);
      return Response.json({
        report: saved?.report ?? null,
        computedAt: saved?.computedAt ?? null,
        questionsNow,
      });
    } catch (err) {
      return Response.json(
        { error: msg(err, "Failed to load the saved collision floor.") },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const report = await computeCollisionFloor();
      await saveCollisionFloor(report);
      // questionsTotal was just measured, so it IS the live count — echoing it
      // keeps the panel's staleness check on one code path for both verbs.
      return Response.json({
        report,
        computedAt: new Date().toISOString(),
        questionsNow: report.questionsTotal,
      });
    } catch (err) {
      return Response.json(
        { error: msg(err, "Failed to compute collision floor.") },
        { status: 500 },
      );
    }
  });
}
