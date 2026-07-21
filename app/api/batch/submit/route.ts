// ---------------------------------------------------------------------------
// API route: POST /api/batch/submit
//
// Launch a batch for one job kind. Body: { kind, scope } where scope is the
// job-specific launch payload (question_generation: { difficulties, documentIds? };
// cluster_labeling: { runId }). Config-scoped, so build() sees the right tab.
//
//   • kind with no handler yet → 501 (recognized, "coming soon" — plan phasing).
//   • build() returns nothing  → 200 { job: null } (no pending work — not an error).
//   • otherwise                → 200 { job } (submitted; poll to see it land).
//
// Additive: this never touches the existing synchronous flows — it's a separate
// entry the UI offers when the config's preference selects "batch" for the kind.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { providerOfKind } from "@/lib/batch/types";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";

const Body = z.object({
  kind: z.enum([
    "question_generation",
    "ndcg_ranking",
    "cluster_labeling",
    "ingest_embedding",
  ]),
  scope: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    const { kind, scope } = body.data;
    const handler = handlerFor(kind);
    if (!handler) {
      return Response.json(
        { error: `Batch submission for ${kind} is coming soon.` },
        { status: 501 },
      );
    }

    const configId = activeConfig().id;
    const config = await getConfig(configId);
    let built;
    try {
      built = await handler.build(scope ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build the batch.";
      return Response.json({ error: message }, { status: 400 });
    }
    if (!built || built.requests.length === 0) {
      return Response.json({ job: null, reason: "Nothing to submit — no pending work for this job." });
    }

    try {
      const job = await submitBatch({
        kind,
        provider: providerOfKind(kind),
        configId,
        configLabel: config?.label ?? "—",
        requests: built.requests,
        input: built.input,
        submitMeta: built.submitMeta,
      });
      return Response.json({ job });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to submit the batch.";
      return Response.json({ error: message }, { status: 502 });
    }
  });
}
