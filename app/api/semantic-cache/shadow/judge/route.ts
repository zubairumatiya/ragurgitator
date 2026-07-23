// ---------------------------------------------------------------------------
// API route: POST /api/semantic-cache/shadow/judge
//
// Two modes (discriminated on `mode`):
//   llm   — on-demand batch LLM judge over a space's events. The Run judge
//           button; bulk (verdict null) or boundary re-judge (rejudge:true) with
//           a selectable model and optional sim band.
//   human — a single Accept/Reject verdict on one event (overrides any LLM one).
//
// Global (shadow events are pooled per vector-space).
// ---------------------------------------------------------------------------
import { z } from "zod";

import { config } from "@/lib/config";
import { parseBody } from "@/lib/http/body";
import { judgeShadowEvents, setHumanVerdict } from "@/lib/rag/semanticCacheCalibration";

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
    const message = err instanceof Error ? err.message : "Judging failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
