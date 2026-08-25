// API route: GET/POST /api/semantic-cache/pairs
//
// The GENERATED half of the cache-key eval pair set (0040).
//
// GET  — counts: how many pairs exist, the same/different split, and how many eval
//        questions still have none, so the panel can say what a run would cover.
// POST — generate pairs for questions that have none. Honours this config's Batch
//        API preference for the `cache_pair_generation` job:
//          • "batch"    → submit the whole gap at −50% and return the job; results
//                         land on a later poll.
//          • "standard" → run a bounded inline pass now and return the counts.
//        Same prompt, parse, and labels either way.
//
// Config-scoped: the gap query is scoped to the active config's eval bank, even
// though the pair table itself is global (a pair is a property of two question
// texts, and pooling every label into one set is the point).
import { z } from "zod";

import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getBatchSavings } from "@/lib/rag/batchStore";
import { getConfig } from "@/lib/rag/configStore";
import {
  generatePairs,
  pairStats,
  PairGenAlreadyRunningError,
} from "@/lib/rag/semanticCachePairs";
import { probeTriggerNote, triggerProbeReplay } from "@/lib/rag/probeReplayTrigger";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";
import { isBatchEnabled } from "@/lib/batch/types";
import { assertDemoAllows } from "@/lib/demo/policy";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      return Response.json(await pairStats());
    } catch (err) {
      return Response.json({ error: msg(err, "Failed to load pair stats.") }, { status: 500 });
    }
  });
}

const Body = z.object({
  // Caps the inline pass (and the batch build). Omitted = each path's own
  // default: bounded inline, the whole bank in batch.
  limit: z.number().int().positive().max(5000).optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    await assertDemoAllows("sweep");
    const configId = activeConfig().id;
    try {
      const savings = await getBatchSavings(configId);
      if (isBatchEnabled(savings, "cache_pair_generation")) {
        const handler = handlerFor("cache_pair_generation")!;
        const built = await handler.build({ limit: body.data.limit });
        if (!built || built.requests.length === 0) {
          return Response.json({ mode: "batch", job: null, reason: "Every question already has pairs." });
        }
        const cfg = await getConfig(configId);
        const job = await submitBatch({
          kind: "cache_pair_generation",
          provider: built.provider,
          configId,
          configLabel: cfg?.label ?? "config",
          requests: built.requests,
          input: built.input,
          submitMeta: built.submitMeta,
        });
        return Response.json({ mode: "batch", job });
      }

      const result = await generatePairs({ limit: body.data.limit });
      // Stock §3's judge queue from what just landed (Phase 3 of
      // docs/probe-replay-plan.md). Fired HERE rather than inside generatePairs
      // because the launcher pulls in the job registry, which pulls the probe
      // step, which pulls semanticCachePairs back — the trigger belongs at the
      // edge, not in the library it would cycle with. The batch path fires from
      // its own apply(), since that is where its pairs actually appear.
      //
      // Best-effort by construction: triggerProbeReplay never throws, so a
      // generation that paid for pairs still reports them.
      const probes = await triggerProbeReplay();
      return Response.json({
        mode: "inline",
        ...result,
        probeNote: probeTriggerNote(probes),
        stats: await pairStats(),
      });
    } catch (err) {
      if (err instanceof PairGenAlreadyRunningError) {
        return Response.json({ error: err.message }, { status: 409 });
      }
      return Response.json({ error: msg(err, "Pair generation failed.") }, { status: 500 });
    }
  });
}
