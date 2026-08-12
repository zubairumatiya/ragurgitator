// API route: GET/PATCH /api/batch
//
// GET  — the status panel's seed + the Settings Savings subsection's seed:
//        • jobs        — ACCOUNT-WIDE ledger, newest-first (config-labeled).
//        • savings     — the CURRENT config's preference (config-scoped).
//        • inFlight    — this config's non-terminal jobs (the overwrite warning).
//        • inheritedThreshold — the cache cosine floor this config runs at when
//          it sets no override (space calibration, else the default) + which.
//        • emailConfigured — whether Resend can actually email (honest UI copy).
// PATCH — save the Savings preference (a nested partial; read-merge-write).
//
// Config-scoped (withRequestConfig) for the per-config bits; the job list is
// global but harmlessly read inside the same scope.
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  getBatchSavings,
  inFlightForConfig,
  listBatchJobs,
  updateBatchSavings,
} from "@/lib/rag/batchStore";
import { setCascadeEnabled } from "@/lib/rag/configStore";
import {
  keyModelStatus,
  resolveKeyModel,
  uncalibratedKeyModelSpace,
} from "@/lib/rag/semanticCache";
import { emailConfigured } from "@/lib/batch/notify";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    const configId = activeConfig().id;
    // `?jobs=0` — the ledger is account-wide and the widest query here, and the
    // Settings dropdown reads none of it. Opt-out rather than a separate route,
    // so the two callers stay on one payload shape.
    const wantJobs = new URL(request.url).searchParams.get("jobs") !== "0";
    // Started, not awaited: only keyModelStatus needs the saved preference, so
    // awaiting it up front put a serial round trip in front of the other two.
    const savingsPromise = getBatchSavings(configId);
    const [jobs, inFlight, keyModel] = await Promise.all([
      wantJobs ? listBatchJobs() : Promise.resolve([]),
      inFlightForConfig(configId),
      // The CACHE-KEY model in force for this config, its candidates, and what
      // that model's space serves at. The threshold rides inside: it's keyed by
      // the KEY model's space, not the retrieval model's, so the two can't be
      // read independently without one of them being wrong.
      savingsPromise.then((s) => keyModelStatus(s.semanticCache.keyModel)),
    ]);
    const savings = await savingsPromise;
    return Response.json({
      jobs,
      savings,
      inFlight,
      // What this config's cache threshold falls back to when it sets no override
      // of its own — the Settings input shows it as the placeholder, so an empty
      // field still tells you the number actually in force.
      inheritedThreshold: keyModel.threshold,
      keyModel,
      emailConfigured: emailConfigured(),
      // Saver-mode toggle (0032) — seeds the Savings section's cascade switch.
      cascadeEnabled: activeConfig().cascadeEnabled,
    });
  });
}

const Choice = z.enum(["standard", "batch"]);

// One choice per job; an omitted key means "unchanged".
const Body = z.object({
  jobs: z
    .object({
      question_generation: Choice.optional(),
      ndcg_ranking: Choice.optional(),
      cluster_labeling: Choice.optional(),
      ingest_embedding: Choice.optional(),
    })
    .optional(),
  // Saver-mode toggle (0032) — the FrugalGPT cascade on/off for this config. Not
  // part of BatchSavings; written to configs.cascade_enabled separately.
  cascadeEnabled: z.boolean().optional(),
  // `threshold`, `keyModel` and `acceptTarget` are all tri-state and the
  // distinction matters: omitted = leave the override as it is, null = clear it
  // (fall back to the global/space value), a value = pin this config to it.
  semanticCache: z
    .object({
      serve: z.boolean().optional(),
      threshold: z.number().min(0).max(1).nullable().optional(),
      keyModel: z.string().min(1).nullable().optional(),
      // Floor of 0.5 matches coerceAcceptTarget in lib/batch/types.ts. Enforcing
      // it HERE too is what makes a bad value an error instead of a silent
      // discard: the store would coerce 0.3 to null (inherit) and the number
      // would just vanish on the next read.
      acceptTarget: z.number().min(0.5).max(1).nullable().optional(),
    })
    .optional(),
  // Acknowledges the uncalibrated-space refusal below. Only meaningful
  // alongside a keyModel change; ignored otherwise.
  forceKeyModel: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    const configId = activeConfig().id;

    // --- the cache-key model switch, guarded ---------------------------------
    // Thresholds are keyed by vector-space, so changing the key model can move
    // this config into a space with no calibrated row — silently dropping it
    // back to the conservative default (or, the other way, silently loosening
    // it). Refuse rather than flip: the client must either calibrate the target
    // space first, or say `forceKeyModel` and own the fallback.
    const keyModelPatch = body.data.semanticCache?.keyModel;
    if (keyModelPatch !== undefined) {
      const current = (await getBatchSavings(configId)).semanticCache.keyModel;
      const target = resolveKeyModel(keyModelPatch);
      // resolveKeyModel silently falls back on an unknown id — right for the
      // read path (never break an answer over a stale blob), wrong for a write:
      // saving a typo'd model that quietly means something else is exactly the
      // silent flip this guard exists to prevent.
      if (keyModelPatch !== null && target !== keyModelPatch) {
        return Response.json(
          { error: `Unknown embedding model "${keyModelPatch}".` },
          { status: 400 },
        );
      }
      // Only a real CHANGE is gated. Re-saving the Savings form with the model
      // it already runs on must not fail just because that space is uncalibrated.
      if (target !== resolveKeyModel(current) && !body.data.forceKeyModel) {
        const blocked = await uncalibratedKeyModelSpace(target);
        if (blocked) {
          return Response.json(
            {
              error:
                `"${target}" has no calibrated threshold — its space ` +
                `"${blocked.space}" would fall back to ${blocked.fallbackThreshold.toFixed(3)}. ` +
                `Calibrate it on Appraise → Semantic caching first, or confirm the switch.`,
              uncalibratedSpace: blocked,
            },
            { status: 409 },
          );
        }
      }
    }

    // Saver-mode toggle rides in the same Savings patch; write it separately from
    // the BatchSavings blob (updateBatchSavings ignores the extra field).
    if (body.data.cascadeEnabled !== undefined) {
      if ((await setCascadeEnabled(configId, body.data.cascadeEnabled)) === null) {
        return Response.json({ error: "Config not found." }, { status: 404 });
      }
    }
    const savings = await updateBatchSavings(configId, body.data);
    if (!savings) return Response.json({ error: "Config not found." }, { status: 404 });
    return Response.json({
      savings,
      // activeConfig() is loaded at request start (stale after the write), so echo
      // the value we just set when present.
      cascadeEnabled: body.data.cascadeEnabled ?? activeConfig().cascadeEnabled,
    });
  });
}
