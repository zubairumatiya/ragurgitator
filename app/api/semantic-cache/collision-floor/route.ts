// API route: GET/POST /api/semantic-cache/collision-floor?population=eval|pairs|traffic
//
// Config-scoped — every floor is derived from ONE config's key-model space, so both
// verbs are scoped the same way.
//
// ONE FLOOR, THREE POPULATIONS (see lib/rag/floorPopulations.ts). Same arithmetic —
// the max cosine among known-different pairs — over three sources of "different":
// the eval bank's ground-truth chunk ids, the generated pair bank's LLM labels, and
// rejected real traffic. `population` defaults to `eval`, which is the only one
// that may be applied, the only one that is saved, and the only one this route
// answered before.
//
// POST — compute the selected population's floor and return it WITHOUT applying it
//        (applying is the apply box's job). Pure arithmetic over already-cached
//        vectors, so no LLM calls and no embedding. The eval population also SAVES
//        its report (0037) so the panel survives navigation; the two bounds are
//        cheap enough to recompute and have no row to save into.
// GET  — what can be shown for free: the eval population's last saved report (or
//        { report: null }), the traffic floor computed on the spot (it is one
//        indexed SQL read of similarities the serving path already stored), and
//        nothing for the pair bank, whose floor pulls vectors and so waits for an
//        explicit POST.
//
// The eval save is BEST-EFFORT and deliberately after the fact: a computed report is
// the expensive thing here, and a persistence problem must never turn a successful
// calibration into a 500.
import { replayBoundFloor } from "@/lib/rag/floorPopulations";
import { withRequestConfig } from "@/lib/http/configScope";
import { readCollisionFloorState, saveCollisionFloor } from "@/lib/rag/collisionFloorStore";
import { computeBoundFloor, isFloorPopulation } from "@/lib/rag/floorPopulations";
import { computeCollisionFloor } from "@/lib/rag/semanticCacheCalibration";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

// An unknown ?population= falls back to `eval` rather than erroring: the default is
// the safe, saved, applicable one, and a typo'd query string should not take the
// panel down.
const populationOf = (request: Request) => {
  const p = new URL(request.url).searchParams.get("population");
  return isFloorPopulation(p) ? p : "eval";
};

export async function GET(request: Request) {
  const population = populationOf(request);
  return withRequestConfig(request, async () => {
    try {
      if (population === "eval") return Response.json(await readCollisionFloorState());
      // The pair bank reads banked vectors — not free, so it is never computed on
      // a page load. An explicit null (rather than an omitted key) is what tells
      // the panel "nothing yet, press Compute".
      if (population === "pairs") return Response.json({ bound: null });
      return Response.json({ bound: await computeBoundFloor("traffic") });
    } catch (err) {
      return Response.json(
        { error: msg(err, "Failed to load the saved collision floor.") },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  const population = populationOf(request);
  return withRequestConfig(request, async () => {
    try {
      if (population !== "eval") {
        // THE PAIR-BANK FLOOR, REPLAYED for a guest — phase 3 of
        // docs/demo-cache-replay-plan.md, and the carve-out is the function as
        // everywhere else in lib/demo/replayView: null for a real account, which
        // falls through to the real arithmetic below unchanged.
        //
        // This pill reads 0 for every guest today, and it is the clearest sign
        // the demo shipped the wrong artifact: the floor needs a banked vector
        // per hard negative, and `embedding_cache` is the 107 MB the clone
        // deliberately leaves behind. The matrix has the cosines instead, so the
        // floor is one column of it subsetted to the pairs the visitor holds.
        return Response.json({
          bound: (await replayBoundFloor(population)) ?? (await computeBoundFloor(population)),
        });
      }
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
