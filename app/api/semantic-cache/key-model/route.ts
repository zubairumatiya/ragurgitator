// API route: GET/POST /api/semantic-cache/key-model
//
// The CACHE-KEY model — the embedding model incoming questions are keyed under
// for the proximity match, decoupled from the config's retrieval model. See
// docs/semantic-cache-key-model-plan.md, Phases 1 and 3.
//
// GET  — the model in force for the scoped config, where it came from (own
//        override vs the global default), what its space serves at, and the
//        full candidate list. Every REGISTERED model is a candidate: the
//        cache-key vector never touches a chunks_* table, so `ingestable` is
//        irrelevant here.
// POST — three actions:
//        • sweep    — score every candidate on the pooled pair set and return
//                     the leaderboard. Embedding-only (no LLM calls), and every
//                     text goes through embedQueryCached, so a re-run is nearly
//                     free. NOT folded into GET: the first run pays for real
//                     embeddings and a page load must never do that silently.
//        • apply    — write the per-config override, for one config or all.
//        • backfill — re-embed this config's cached questions under the key
//                     model so a switch has something to hit against.
//
// The UNCALIBRATED-SPACE REFUSAL lives on `apply` here exactly as it does on
// PATCH /api/batch: switching key models moves a config into a new vector-space,
// and an uncalibrated one silently falls back to defaultThreshold.
//
// Config-scoped (withRequestConfig) — but note `apply` with scope "all" writes
// every config, which is how a "global default" is expressed at runtime: the
// true global lives in lib/config.ts and is a code constant.
import { z } from "zod";

import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getBatchSavings, updateBatchSavings } from "@/lib/rag/batchStore";
import { listClosedConfigs, listConfigs } from "@/lib/rag/configStore";
import { runKeyModelSweep } from "@/lib/rag/keyModelSweep";
import {
  backfillKeyModel,
  keyModelStatus,
  resolveKeyModel,
  scopedAcceptTarget,
  uncalibratedKeyModelSpace,
} from "@/lib/rag/semanticCache";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const savings = await getBatchSavings(activeConfig().id);
      return Response.json(await keyModelStatus(savings.semanticCache.keyModel));
    } catch (err) {
      return Response.json(
        { error: msg(err, "Failed to load the cache-key model.") },
        { status: 500 },
      );
    }
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("sweep"),
    // Restrict the sweep to a subset (a re-run of one row). Omitted = the
    // configured candidate list.
    candidates: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    action: z.literal("apply"),
    // null clears the override, falling back to the global default.
    keyModel: z.string().min(1).nullable(),
    // "config" = the scoped config only. "all" = every config, which is how the
    // effective default is moved without a code change.
    scope: z.enum(["config", "all"]).default("config"),
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("backfill"),
    // Cap on questions re-embedded in one call — this is the cost knob, so it's
    // the caller's to set. Bounded so a stray value can't turn a UI click into
    // an unbounded provider bill.
    limit: z.number().int().positive().max(2000).optional(),
  }),
]);

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const data = body.data;

  return withRequestConfig(request, async () => {
    try {
      if (data.action === "sweep") {
        return Response.json(
          await runKeyModelSweep(await scopedAcceptTarget(), data.candidates),
        );
      }

      if (data.action === "backfill") {
        const savings = await getBatchSavings(activeConfig().id);
        const keyModel = resolveKeyModel(savings.semanticCache.keyModel);
        return Response.json(await backfillKeyModel(keyModel, data.limit));
      }

      // --- apply -------------------------------------------------------------
      const target = resolveKeyModel(data.keyModel);
      if (data.keyModel !== null && target !== data.keyModel) {
        return Response.json(
          { error: `Unknown embedding model "${data.keyModel}".` },
          { status: 400 },
        );
      }
      // "all" includes CLOSED configs: a closed config still answers questions
      // through its own cache, so leaving it on the old key model would make
      // "apply everywhere" quietly untrue.
      const ids =
        data.scope === "all"
          ? [...(await listConfigs()), ...(await listClosedConfigs())].map((c) => c.id)
          : [activeConfig().id];

      // Gate a real CHANGE only, exactly like PATCH /api/batch. Re-applying the
      // model a config already runs on — or clearing an override back to the
      // same effective model — must not be refused just because that space
      // happens to be uncalibrated; nothing about the safety posture moves.
      const currents = await Promise.all(
        ids.map(async (id) => resolveKeyModel((await getBatchSavings(id)).semanticCache.keyModel)),
      );
      const changes = currents.some((c) => c !== target);
      if (changes && !data.force) {
        const blocked = await uncalibratedKeyModelSpace(target);
        if (blocked) {
          return Response.json(
            {
              error:
                `"${target}" has no calibrated threshold — its space ` +
                `"${blocked.space}" would fall back to ` +
                `${blocked.fallbackThreshold.toFixed(3)}. Calibrate it first, or ` +
                `confirm the switch.`,
              uncalibratedSpace: blocked,
            },
            { status: 409 },
          );
        }
      }
      let updated = 0;
      for (const id of ids) {
        if (await updateBatchSavings(id, { semanticCache: { keyModel: data.keyModel } })) {
          updated += 1;
        }
      }
      const savings = await getBatchSavings(activeConfig().id);
      return Response.json({
        updated,
        keyModel: await keyModelStatus(savings.semanticCache.keyModel),
      });
    } catch (err) {
      return Response.json({ error: msg(err, "Request failed.") }, { status: 500 });
    }
  });
}
