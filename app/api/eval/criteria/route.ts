// API route: GET/PATCH /api/eval/criteria
//
// GET returns the active config's saved criteria + the config summary + the autotune
// chunk-scope options (labeled chunks grouped by document, 0025) — what the
// nav-level Settings dropdown seeds its form from (it lives outside the eval page,
// so it can't lean on the eval summary).
//
// PATCH saves the criteria from that dropdown: the metric toggles + per-metric k
// (null => fall back to top_k) + optional min-rate, the difficulty mix, and the
// autotuning settings. The body is a nested partial — only changed fields are sent;
// updateCriteria read-merge-writes the rest.
//
// PATCH also has one side effect beyond the settings row: when the body carries
// the holdout dials (0061) it redraws the held-out test set and returns its size,
// so "held out 98 of 390" is confirmed by the server rather than predicted by the
// form.
//
// Config-scoped so it acts on the tab the dropdown is on.
import { z } from "zod";
import { autotuneModelLadder } from "@/lib/config";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import {
  listAggregateModelOptions,
  listAutotuneModelOptions,
} from "@/lib/rag/embeddingModels";
import { listLlmOptions } from "@/lib/llm/llmModels";
import { availableProviders } from "@/lib/rag/providerAvailability";
import {
  listHoldoutCandidates,
  listHoldoutQuestionIds,
  syncHoldout,
} from "@/lib/rag/autotuneStore";
import { getActiveCriteria, updateCriteria } from "@/lib/rag/evalSettingsStore";
import { listAutotuneScopeOptions } from "@/lib/rag/evalStore";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      // One round trip, not two: availableProviders() is an independent,
      // indexed row-existence query (see keyedProviders — no ciphertext, no
      // Key Vault), so it has nothing to wait on from the other three.
      const [criteria, config, scopeOptions, availability, candidates, held] =
        await Promise.all([
          getActiveCriteria(),
          getConfig(activeConfig().id),
          listAutotuneScopeOptions(),
          availableProviders(),
          // The holdout dials mean nothing without the split they produced, and
          // the count is what tells the user a redraw actually landed.
          listHoldoutCandidates(),
          listHoldoutQuestionIds(),
        ]);
      if (!config) return Response.json({ error: "Config not found." }, { status: 404 });
      // The alternate models a run could try (ladder order), grouped by shared
      // vector space in the Settings checklist. Includes models whose provider
      // has no key — flagged unselectable with a reason, so the checklist can
      // grey them out instead of hiding whole spaces without explanation.
      // One availability lookup shared by both checklists below.
      const autotuneModels = listAutotuneModelOptions(
        availability,
        autotuneModelLadder,
        activeConfig().embeddingModel,
      );
      // Which models may vote in the nDCG ideal ranking (0045). Every registry
      // model, including the base — it votes like any other.
      const aggregateModels = listAggregateModelOptions(
        availability,
        activeConfig().embeddingModel,
      );
      // The answer-generation models for the Settings LLM picker (§9.2). Shares
      // the availability lookup above — one query covers embedding AND LLM
      // providers, so the second picker costs nothing extra.
      const llmModels = listLlmOptions(availability);
      return Response.json({
        criteria,
        config,
        scopeOptions,
        autotuneModels,
        aggregateModels,
        llmModels,
        holdout: { total: candidates.length, held: held.size },
      });
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

// nDCG takes one field the other metrics don't: which models build the ideal
// ranking (0045). null = the default set; a list whitelists registry ids.
const NdcgMetric = z
  .object({
    enabled: z.boolean().optional(),
    k: z.number().int().positive().nullable().optional(),
    minRate: z.number().min(0).max(1).nullable().optional(),
    aggregateModels: z.array(z.string()).nullable().optional(),
  })
  .optional();

const Body = z.object({
  recall: Metric,
  mrr: Metric,
  ndcg: NdcgMetric,
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
      // Held-out test set (0061). `size` is a percentage under mode 'pct' and a
      // question count under 'count'; the seed is stored so the split can be
      // re-derived. A percentage is clamped to 90 below — a holdout past that
      // leaves autotune nothing to tune, which is a mistake, not a setting.
      holdout: z
        .object({
          enabled: z.boolean().optional(),
          mode: z.enum(["pct", "count"]).optional(),
          size: z.number().min(0).max(100000).optional(),
          seed: z.number().int().min(0).max(2147483647).optional(),
        })
        .optional(),
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
      const patch = body.data;
      const holdoutPatch = patch.autotune?.holdout;
      if (holdoutPatch?.size !== undefined && holdoutPatch.mode !== "count") {
        holdoutPatch.size = Math.min(90, holdoutPatch.size);
      }
      const criteria = await updateCriteria(activeConfig().id, patch);
      if (!criteria) {
        return Response.json({ error: "Config not found." }, { status: 404 });
      }
      // Redraw the test set whenever the holdout dials are in the body. Safe to
      // run on every save: the draw is a pure function of (questions, size,
      // seed) and keeps existing members, so an unchanged save moves nothing.
      const holdout = holdoutPatch
        ? await syncHoldout(criteria.autotune.holdout)
        : null;
      return Response.json({ criteria, holdout });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save criteria.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
