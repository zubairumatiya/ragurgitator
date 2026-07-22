// ---------------------------------------------------------------------------
// API route: GET/PATCH /api/batch
//
// GET  — the status panel's seed + the Settings Savings subsection's seed:
//        • jobs        — ACCOUNT-WIDE ledger, newest-first (config-labeled).
//        • savings     — the CURRENT config's preference (config-scoped).
//        • inFlight    — this config's non-terminal jobs (the overwrite warning).
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
import { emailConfigured } from "@/lib/batch/notify";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    const configId = activeConfig().id;
    const [jobs, savings, inFlight] = await Promise.all([
      listBatchJobs(),
      getBatchSavings(configId),
      inFlightForConfig(configId),
    ]);
    return Response.json({
      jobs,
      savings,
      inFlight,
      emailConfigured: emailConfigured(),
      // Saver-mode toggle (0032) — seeds the Savings section's cascade switch.
      cascadeEnabled: activeConfig().cascadeEnabled,
    });
  });
}

const Choice = z.enum(["standard", "batch"]);

const Body = z.object({
  mode: z.enum(["bulk", "individual"]).optional(),
  bulk: z.object({ embedding: Choice.optional(), llm: Choice.optional() }).optional(),
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
