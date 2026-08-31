// API route: POST /api/batch/submit
//
// Launch a batch for one job kind. Body: { kind, scope } where scope is the
// job-specific launch payload. Config-scoped, so build() sees the right tab.
//
//   • kind with no handler yet → 501 (recognized, "coming soon").
//   • build() returns nothing  → 200 { job: null } (no pending work, not an error).
//   • otherwise                → 200 { job } (submitted; poll to see it land).
//
// ONE KIND HAS A GUEST PATH: `cache_pair_screen` resolves verdicts the publish
// already banked instead of submitting anything (phase 3b of
// docs/demo-cache-lab-plan.md). Every other kind is blocked as before.
//
// Additive: this never touches the existing synchronous flows — it's a separate
// entry the UI offers when the config's preference selects "batch" for the kind.
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { hasOpenJobOfKind } from "@/lib/rag/batchStore";
import { submitBatch } from "@/lib/batch/orchestrator";
import { assertDemoAllows } from "@/lib/demo/policy";
import { screenReplay } from "@/lib/demo/replayView";

const Body = z.object({
  kind: z.enum([
    "question_generation",
    "ndcg_ranking",
    "cluster_labeling",
    "ingest_embedding",
    "cache_pair_generation",
    "cache_pair_screen",
  ]),
  scope: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    const { kind, scope } = body.data;
    // THE DEMO GATE, WITH ONE CARVE-OUT — phase 3 of docs/demo-cache-replay-plan.md.
    // The pair screen asks a model whether each generated pair is labelled
    // correctly, and the quarantine drops the ones it catches. A guest cannot buy
    // that answer, and does not have to: F3 already obtained it on the operator's
    // account, and the banked matrix (0080) carries which pairs it contradicted.
    // So the screen RESOLVES the quarantine over the pairs the visitor has reached
    // rather than judging them — and the leaderboard moves when it does, because
    // those pairs leave the pool.
    //
    // Narrow by construction, on both halves. The kind is named literally, and
    // screenReplay returns null for anyone who is not a guest — so no other batch
    // kind and no real account can reach this branch, and the gate below stays
    // unconditional, which is what keeps scripts/guards.ts sweep 6 honest. Fails
    // closed: without these two lines a guest is simply refused, as before.
    const banked = kind === "cache_pair_screen" ? await screenReplay() : null;
    if (banked) {
      // `job: null` in the same field a submission fills, plus a discriminator the
      // panel can branch on: nothing was submitted, nothing will land on a later
      // poll, and a UI that waited for a job here would wait forever.
      return Response.json({ job: null, published: true, screened: banked });
    }
    await assertDemoAllows("batch");
    const handler = handlerFor(kind);
    if (!handler) {
      return Response.json(
        { error: `Batch submission for ${kind} is coming soon.` },
        { status: 501 },
      );
    }

    // A singleton kind's build picks its own work out of the database, so a
    // second submission while the first is still open would re-do — and re-pay
    // for — the same rows. 200 with a reason rather than an error: nothing is
    // wrong, the work is already under way.
    if (handler.singleton && (await hasOpenJobOfKind(kind))) {
      return Response.json({ job: null, reason: "One of these is already running — wait for it to land." });
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
        provider: built.provider,
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
