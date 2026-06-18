// ---------------------------------------------------------------------------
// API route: /api/eval/questions/[id]/ranking
//
// The per-question graded-nDCG ranking builder (see lib/rag/ranking):
//   - GET  : panel context — the question, saved cluster presets to seed a pool,
//            and the rankings built so far (with which one is ground truth).
//   - POST : one mutation, by `action`:
//       { action: "aggregate", clusterRunId } — build the cross-model aggregate
//       { action: "llm_pool" } / { action: "llm_rerank" } — LLM comparison ranking
//       { action: "manual", chunkIds }       — save a hand-edited order
//       { action: "truth", rankingId }        — promote one ranking to ground truth
//     Every mutation returns the refreshed context so the panel re-renders cleanly.
//
// `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import {
  buildAggregateRanking,
  buildLlmRanking,
  getRankingContext,
  setManualRanking,
  setOfficialRanking,
} from "@/lib/rag/ranking";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("aggregate"),
    clusterRunId: z.string({ error: "`clusterRunId` is required." }).min(1, {
      error: "`clusterRunId` is required.",
    }),
  }),
  z.object({ action: z.literal("llm_pool") }),
  z.object({ action: z.literal("llm_rerank") }),
  z.object({
    action: z.literal("manual"),
    chunkIds: z
      .array(z.string({ error: "`chunkIds` must be an array of chunk id strings." }), {
        error: "`chunkIds` must be an array of chunk id strings.",
      })
      .min(1, { error: "`chunkIds` must list at least one chunk." }),
  }),
  z.object({
    action: z.literal("truth"),
    rankingId: z.string({ error: "`rankingId` is required." }).min(1, {
      error: "`rankingId` is required.",
    }),
  }),
]);

const notFound = () =>
  Response.json({ error: "Question not found under the active config." }, { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const context = await getRankingContext(id);
    if (!context) return notFound();
    return Response.json(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load ranking context.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const data = body.data;

  try {
    switch (data.action) {
      case "aggregate":
        await buildAggregateRanking(id, data.clusterRunId);
        break;
      case "llm_pool":
        await buildLlmRanking(id, "pool");
        break;
      case "llm_rerank":
        await buildLlmRanking(id, "rerank");
        break;
      case "manual":
        await setManualRanking(id, data.chunkIds);
        break;
      case "truth": {
        const ok = await setOfficialRanking(id, data.rankingId);
        if (!ok) return Response.json({ error: "Ranking not found." }, { status: 404 });
        break;
      }
    }
    // Hand back the refreshed panel state after any mutation.
    const context = await getRankingContext(id);
    if (!context) return notFound();
    return Response.json(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ranking action failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
