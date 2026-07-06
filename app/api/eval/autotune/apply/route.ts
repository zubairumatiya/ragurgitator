// ---------------------------------------------------------------------------
// API route: POST /api/eval/autotune/apply
//
// Applies ONE autotune candidate the user picked from a `chunk-choice` event
// (apply mode 'choose', >1 family cleared — eval-autotuning-plan §5.2). Body:
// { chunkId, family: 'size'|'model'|'size+model', size?, overlap?, model? }.
// Persists the override, confirms it through real retrieval, and reverts if it
// regressed — same promote→persist→confirm path the engine uses (§5.3).
// ---------------------------------------------------------------------------
import { applyAutotuneCandidate, type CandidateFamily } from "@/lib/rag/autotune";
import { withRequestConfig } from "@/lib/http/configScope";

const FAMILIES: readonly CandidateFamily[] = ["size", "model", "size+model"];

export async function POST(request: Request) {
  return withRequestConfig(request, async () => {
    const body = (await request.json().catch(() => null)) as {
      chunkId?: string;
      family?: string;
      size?: number;
      overlap?: number;
      model?: string;
    } | null;

    const family = FAMILIES.find((f) => f === body?.family);
    if (!body?.chunkId || !family) {
      return Response.json(
        { error: "chunkId and a valid family are required." },
        { status: 400 },
      );
    }
    if (family !== "model" && typeof body.size !== "number") {
      return Response.json(
        { error: `family '${family}' requires a size.` },
        { status: 400 },
      );
    }
    if (family !== "size" && typeof body.model !== "string") {
      return Response.json(
        { error: `family '${family}' requires a model.` },
        { status: 400 },
      );
    }

    const result = await applyAutotuneCandidate(body.chunkId, {
      family,
      size: body.size ?? null,
      overlap: body.overlap ?? null,
      model: body.model ?? null,
    });
    const status = result.status === "failed" ? 422 : 200;
    return Response.json(result, { status });
  });
}
