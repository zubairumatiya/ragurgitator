// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------
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
import { inheritedThreshold } from "@/lib/rag/semanticCache";
import { emailConfigured } from "@/lib/batch/notify";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    const configId = activeConfig().id;
    const [jobs, savings, inFlight, inherited] = await Promise.all([
      listBatchJobs(),
      getBatchSavings(configId),
      inFlightForConfig(configId),
      // What this config's cache threshold falls back to when it sets no override
      // of its own — the Settings input shows it as the placeholder, so an empty
      // field still tells you the number actually in force.
      inheritedThreshold(activeConfig().embeddingModel),
    ]);
    return Response.json({
      jobs,
      savings,
      inFlight,
      inheritedThreshold: inherited,
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
  // `threshold` is tri-state and the distinction matters: omitted = leave the
  // override as it is, null = clear it (fall back to the space/default value), a
  // number = pin this config to that cosine floor.
  semanticCache: z
    .object({
      serve: z.boolean().optional(),
      threshold: z.number().min(0).max(1).nullable().optional(),
    })
    .optional(),
});

export async function PATCH(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    const configId = activeConfig().id;
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
