// API route: GET/POST /api/semantic-cache/key-model
//
// The CACHE-KEY model — the embedding model incoming questions are keyed under for
// the proximity match, decoupled from the config's retrieval model.
//
// GET  — the model in force for the scoped config, where it came from, what its
//        space serves at, and the full candidate list. Every REGISTERED model is a
//        candidate: the key vector never touches a chunks_* table. For a GUEST it
//        also carries `publishedSweep`, the leaderboard the publish banked (0077),
//        because the POST that would produce one is a spend the demo won't make.
// POST — three actions:
//        • sweep    — score every candidate on the pooled pair set. Embedding-only
//                     and cached, so a re-run is nearly free. NOT folded into GET:
//                     the first run pays for real embeddings and a page load must
//                     never do that silently.
//        • apply    — write the per-config override, for one config or all.
//        • backfill — re-embed this config's cached questions under the key model.
//
// The UNCALIBRATED-SPACE REFUSAL lives on `apply` here exactly as on PATCH
// /api/batch: switching key models moves a config into a new vector-space, and an
// uncalibrated one silently falls back to defaultThreshold.
//
// Config-scoped — but `apply` with scope "all" writes every config, which is how a
// "global default" is expressed at runtime: the true global is a code constant.
//
// `sweep` IS CANCELLABLE, and has to be: a cold cache makes it ~an hour of
// sequential embedding, and an abandoned one used to hold the process for that
// whole hour (killing the dev server took SIGKILL). Two independent stop signals,
// because they cover different accidents:
//   • request.signal — the tab closed or the client aborted. Nothing is left to
//     return the partial result to, but the vectors already bought stay banked.
//   • the cancel registry, under a runId the CLIENT names in the body — an
//     explicit Cancel while the request is still open, so the partial leaderboard
//     comes back instead of being discarded. A plain JSON POST can't hand out a
//     server-chosen id (its response only exists once the work is done), which is
//     why this direction is inverted from the NDJSON routes'.
import { z } from "zod";

import { activeUserId } from "@/lib/auth/userScope";
import { parseBody } from "@/lib/http/body";
import { registerRunId, isCancelled, unregisterRun } from "@/lib/http/cancelRegistry";
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
import { assertDemoAllows, demoBlocks } from "@/lib/demo/policy";
import { readPublishedSweep } from "@/lib/rag/publishedSweep";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      const savings = await getBatchSavings(activeConfig().id);
      return Response.json({
        ...(await keyModelStatus(savings.semanticCache.keyModel)),
        // THE PUBLISHED SWEEP, for a guest only (phase 1 of
        // docs/demo-cache-lab-plan.md). It seeds the panel's `sweep` state, which
        // is the whole unlock: §4's leaderboard and its precision slider render
        // inside `{sweep && …}` and cost nothing to re-derive, so handing the
        // panel a result turns three disabled buttons into a live control with
        // zero further requests.
        //
        // PACKED, and handed on untouched (phase 1.5): the panel calls
        // unpackSweep before it reads a curve. Unpacking here would put back on
        // the wire exactly what packing took off the Postgres hop.
        //
        // GATED ON GUEST, not on "a row exists", and the reason is the same rule
        // lib/demo/policy holds everywhere: a MEASUREMENT may not imply a
        // computation that did not happen. The operator's own account can run
        // the real sweep, and pre-filling their table with a banked one — with
        // no note saying so, since PUBLISHED_SWEEP_NOTE is phase 2's — would be
        // exactly that. Null for everyone else, and the panel opens empty as it
        // always has.
        publishedSweep: (await demoBlocks()) ? await readPublishedSweep() : null,
      });
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
    // The id POST /api/eval/cancel will name to stop this run. Omitted = no
    // cancel channel; request.signal still applies.
    runId: z.uuid().optional(),
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
    await assertDemoAllows("sweep");
    try {
      if (data.action === "sweep") {
        // A runId already in flight yields no channel rather than stealing the
        // other run's — registerRunId refuses it, and the signal still stops us.
        const runId =
          data.runId && registerRunId(data.runId, activeUserId())
            ? data.runId
            : null;
        try {
          return Response.json(
            await runKeyModelSweep(
              await scopedAcceptTarget(),
              data.candidates,
              () => request.signal.aborted || (runId !== null && isCancelled(runId)),
            ),
          );
        } finally {
          if (runId) unregisterRun(runId);
        }
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
