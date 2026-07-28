// ---------------------------------------------------------------------------
// API route: GET/POST /api/semantic-cache/pairs
//
// The GENERATED half of the cache-key eval pair set (migration 0040, Phase 2 of
// docs/semantic-cache-key-model-plan.md).
//
// GET  — counts: how many pairs exist, the same/different split, and how many
//        eval questions still have none (so the panel can say what a run would
//        cover before it's clicked).
// POST — generate pairs for questions that have none. Honours this config's
//        Batch API preference for the `cache_pair_generation` job:
//          • "batch"    → submit the whole gap to the Anthropic batch API at
//                         −50% and return the job; results land on a later poll.
//          • "standard" → run a bounded inline pass now and return the counts.
//        Same prompt, parse, and labels either way (semanticCachePairs).
//
// Config-scoped: the gap query is scoped to the active config's eval bank, even
// though the pair table itself is global (a pair is a property of two question
// texts, and pooling every label into one set is the point).
// ---------------------------------------------------------------------------
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
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";
import { isBatchEnabled, providerOfKind } from "@/lib/batch/types";

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
          provider: providerOfKind("cache_pair_generation"),
          configId,
          configLabel: cfg?.label ?? "config",
          requests: built.requests,
          input: built.input,
          submitMeta: built.submitMeta,
        });
        return Response.json({ mode: "batch", job });
      }

      const result = await generatePairs({ limit: body.data.limit });
      return Response.json({ mode: "inline", ...result, stats: await pairStats() });
    } catch (err) {
      if (err instanceof PairGenAlreadyRunningError) {
        return Response.json({ error: err.message }, { status: 409 });
      }
      return Response.json({ error: msg(err, "Pair generation failed.") }, { status: 500 });
    }
  });
}
