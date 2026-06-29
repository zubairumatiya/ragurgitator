// ---------------------------------------------------------------------------
// API route: PATCH /api/eval/criteria
//
// Save the active config's eval criteria from the Settings dropdown (Phase A):
// the metric toggles + per-metric k (null => fall back to top_k) + optional
// min-rate, the difficulty mix, and the autotuning settings (A5; saved now,
// consumed by the Phase C engine). The body is a nested partial — only the
// changed fields are sent; updateCriteria read-merge-writes the rest.
//
// Config-scoped (withRequestConfig) so it acts on the tab the dashboard is on.
// Reads come back through GET /api/eval (the summary now carries `criteria`).
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { updateCriteria } from "@/lib/rag/evalSettingsStore";

const Metric = z
  .object({
    enabled: z.boolean().optional(),
    k: z.number().int().positive().nullable().optional(),
    minRate: z.number().min(0).max(1).nullable().optional(),
  })
  .optional();

const Body = z.object({
  recall: Metric,
  ndcg: Metric,
  difficulties: z.array(z.enum(["easy", "medium", "hard"])).optional(),
  autotune: z
    .object({
      sizeLadder: z.array(z.number().int().positive()).min(1).optional(),
      overlapPct: z.number().min(0).max(0.9).optional(),
      apply: z.enum(["choose", "auto_best"]).optional(),
      search: z.enum(["first_success", "exhaustive"]).optional(),
    })
    .optional(),
});

export async function PATCH(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    try {
      const criteria = await updateCriteria(activeConfig().id, body.data);
      if (!criteria) {
        return Response.json({ error: "Config not found." }, { status: 404 });
      }
      return Response.json({ criteria });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save criteria.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
