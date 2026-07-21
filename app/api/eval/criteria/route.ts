// ---------------------------------------------------------------------------
// API route: GET/PATCH /api/eval/criteria
//
// GET returns the active config's saved criteria + the config summary (top-k
// placeholder, corpus link, auto-sync state) + the autotune chunk-scope options
// (labeled chunks grouped by document, 0025) — what the nav-level Settings
// dropdown seeds its form from (it lives outside the eval page, so it can't
// lean on the eval summary).
//
// PATCH saves the criteria from that dropdown (Phase A): the metric toggles +
// per-metric k (null => fall back to top_k) + optional min-rate, the difficulty
// mix, and the autotuning settings (A5). The body is a nested partial — only
// the changed fields are sent; updateCriteria read-merge-writes the rest.
//
// Config-scoped (withRequestConfig) so it acts on the tab the dropdown is on.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { autotuneModelLadder } from "@/lib/config";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { listAutotuneModelOptions } from "@/lib/rag/embeddingModels";
import { getActiveCriteria, updateCriteria } from "@/lib/rag/evalSettingsStore";
import { listAutotuneScopeOptions } from "@/lib/rag/evalStore";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const [criteria, config, scopeOptions] = await Promise.all([
        getActiveCriteria(),
        getConfig(activeConfig().id),
        listAutotuneScopeOptions(),
      ]);
      if (!config) return Response.json({ error: "Config not found." }, { status: 404 });
      // The alternate models a run could try right now (keyed, ladder order),
      // grouped by shared vector space in the Settings checklist.
      const autotuneModels = listAutotuneModelOptions(
        autotuneModelLadder,
        activeConfig().embeddingModel,
      );
      return Response.json({ criteria, config, scopeOptions, autotuneModels });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load criteria.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

const Metric = z
  .object({
    enabled: z.boolean().optional(),
    k: z.number().int().positive().nullable().optional(),
    minRate: z.number().min(0).max(1).nullable().optional(),
  })
  .optional();

const Body = z.object({
  recall: Metric,
  mrr: Metric,
  ndcg: Metric,
  difficulties: z.array(z.enum(["easy", "medium", "hard"])).optional(),
  autotune: z
    .object({
      sizeLadder: z.array(z.number().int().positive()).min(1).optional(),
      overlapPct: z.number().min(0).max(0.9).optional(),
      apply: z.enum(["choose", "auto_best"]).optional(),
      search: z.enum(["first_success", "exhaustive"]).optional(),
      stopEarly: z.boolean().optional(),
      keepBest: z.boolean().optional(),
      chunkScope: z.array(z.string().uuid()).nullable().optional(),
      // Model scope (0030): null = all usable models; [] = size-only.
      modelScope: z.array(z.string()).nullable().optional(),
      // Trial fusion pool (0027): null = follow live retrieval's pool.
      fusionPool: z.number().int().min(1).max(1000).nullable().optional(),
    })
    .optional(),
  retrieval: z
    .object({
      // Live fusion pool (0027): null = auto (max(top_k * 4, 50)).
      fusionPool: z.number().int().min(1).max(1000).nullable().optional(),
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
