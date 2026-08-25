// API route: POST /api/semantic-cache/shadow/judge
//
// Two modes (discriminated on `mode`):
//   llm   — on-demand batch LLM judge over a space's events. The Run judge
//           button; bulk (verdict null) or boundary re-judge (rejudge:true) with
//           a selectable model and optional sim band.
//   human — a single Accept/Reject verdict on one event (overrides any LLM one).
//
// Global (shadow events are pooled per vector-space).
import { z } from "zod";

import { config } from "@/lib/config";
import { withRequestUser } from "@/lib/http/configScope";
import { parseBody } from "@/lib/http/body";
import {
  JudgeAlreadyRunningError,
  judgeShadowEvents,
  setHumanVerdict,
} from "@/lib/rag/semanticCacheCalibration";
import { assertDemoAllows } from "@/lib/demo/policy";

const Body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("llm"),
    space: z.string().min(1),
    model: z.string().min(1),
    simMin: z.number().min(0).max(1).optional(),
    simMax: z.number().min(0).max(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
    rejudge: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal("human"),
    id: z.string().min(1),
    verdict: z.enum(["accept", "reject"]),
  }),
]);

export async function POST(request: Request) {
  const parsed = await parseBody(request, Body);
  if (parsed.response) return parsed.response;
  const body = parsed.data;

  return withRequestUser(async () => {
    // ONE BOOLEAN IS THE WHOLE CARVE-OUT, and it is the same shape as
    // bulk-generate's `cachedOnly` (phase 6.1): the two modes are already
    // different levers wearing one route, and only one of them reaches a model.
    // `human` is a single UPDATE on a row the caller already owns, so gating it
    // bought no spend limit and cost the demo its calibration workbench.
    //
    // Widening this condition widens the demo's spend surface, which is why the
    // condition itself — not merely the presence of a gate call — is pinned as a
    // needle in scripts/guards.ts (sweep 6b).
    if (body.mode !== "human") await assertDemoAllows("judge");
    try {
      if (body.mode === "human") {
        await setHumanVerdict(body.id, body.verdict);
        return Response.json({ ok: true });
      }
      // Restrict to the offered judge models so a stray string can't run arbitrary
      // (or non-existent) models.
      if (!(config.semanticCache.judgeModelOptions as readonly string[]).includes(body.model)) {
        return Response.json(
          { error: `Unknown judge model: ${body.model}` },
          { status: 400 },
        );
      }
      const result = await judgeShadowEvents({
        space: body.space,
        model: body.model,
        simMin: body.simMin,
        simMax: body.simMax,
        limit: body.limit,
        rejudge: body.rejudge,
      });
      return Response.json({ result });
    } catch (err) {
      // A second run over the same space while one is in flight is a conflict, not
      // a server fault — 409 so the UI can say "already running" rather than fail.
      if (err instanceof JudgeAlreadyRunningError) {
        return Response.json({ error: err.message }, { status: 409 });
      }
      const message = err instanceof Error ? err.message : "Judging failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
