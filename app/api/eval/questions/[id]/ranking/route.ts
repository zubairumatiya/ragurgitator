// API route: /api/eval/questions/[id]/ranking
//
// The per-question graded-nDCG ranking builder:
//   - GET  : panel context — the question and the rankings built so far (with which
//            one is ground truth).
//   - POST : one mutation, by `action`:
//       { action: "aggregate" }                            — cross-model aggregate
//       { action: "llm_pool" } / { action: "llm_rerank" }  — LLM comparison ranking
//       { action: "manual", chunkIds }                     — save a hand-edited order
//       { action: "truth", rankingId }                     — promote to ground truth
//     Every mutation returns the refreshed context so the panel re-renders cleanly.
//
// `params` is a Promise in this Next.js version — await it.
import { z } from "zod";
import { assertDemoAllows } from "@/lib/demo/policy";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import {
  buildAggregateRanking,
  buildLlmRanking,
  getRankingContext,
  setManualRanking,
  setOfficialRanking,
} from "@/lib/rag/ranking";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("aggregate") }),
  z.object({ action: z.literal("llm_pool") }),
  z.object({ action: z.literal("llm_rerank") }),
  z.object({
    action: z.literal("manual"),
    chunkIds: z
      .array(z.string({ error: "`chunkIds` must be an array of chunk id strings." }), {
        error: "`chunkIds` must be an array of chunk id strings.",
      })
      .min(1, { error: "`chunkIds` must list at least one chunk." }),
    // Which ranking this edit came from, so the panel folds the original in place.
    derivedFromKind: z.enum(["aggregate", "llm_pool", "llm_rerank", "manual"]).optional(),
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
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRequestConfig(request, async () => {
    try {
      const context = await getRankingContext(id);
      if (!context) return notFound();
      return Response.json(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load ranking context.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const data = body.data;

  return withRequestConfig(request, async () => {
    // OUTSIDE the try. DemoBlockedError has to reach catchingMissingKey (which
    // wraps this callback) to become a 403 with its sentence; caught here it
    // would come back as a 500 whose body happens to read like an explanation.
    //
    // EVERY mutation, not just the two that spend. `aggregate` embeds a
    // candidate pool under each of the config's ndcg_aggregate_models and
    // `llm_pool`/`llm_rerank` need an answer-model key, so those are the usual
    // gate. `manual` and `truth` are free — and they rewrite the GROUND TRUTH
    // the Eval tab's nDCG is scored against, which would let a visitor drag the
    // published number to 1.000 by reordering a list. The published build's
    // graded set is the demo's measurement, not one of its dials.
    await assertDemoAllows("rank");

    try {
      switch (data.action) {
        case "aggregate":
          await buildAggregateRanking(id);
          break;
        case "llm_pool":
          await buildLlmRanking(id, "pool");
          break;
        case "llm_rerank":
          await buildLlmRanking(id, "rerank");
          break;
        case "manual":
          await setManualRanking(id, data.chunkIds, data.derivedFromKind);
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
  });
}
