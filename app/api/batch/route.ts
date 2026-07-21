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
import { emailConfigured } from "@/lib/batch/notify";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    const configId = activeConfig().id;
    const [jobs, savings, inFlight] = await Promise.all([
      listBatchJobs(),
      getBatchSavings(configId),
      inFlightForConfig(configId),
    ]);
    return Response.json({ jobs, savings, inFlight, emailConfigured: emailConfigured() });
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
});

export async function PATCH(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    const savings = await updateBatchSavings(activeConfig().id, body.data);
    if (!savings) return Response.json({ error: "Config not found." }, { status: 404 });
    return Response.json({ savings });
  });
}
