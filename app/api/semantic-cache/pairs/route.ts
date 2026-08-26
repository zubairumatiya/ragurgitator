// API route: GET/POST /api/semantic-cache/pairs
//
// The GENERATED half of the cache-key eval pair set (0040).
//
// GET  — counts: how many pairs exist, the same/different split, and how many eval
//        questions still have none, so the panel can say what a run would cover.
//        For a guest it also carries `bankedRemaining`, the size of the shelf the
//        publish left them (null for a real account).
// POST — generate pairs for questions that have none. Honours this config's Batch
//        API preference for the `cache_pair_generation` job:
//          • "batch"    → submit the whole gap at −50% and return the job; results
//                         land on a later poll.
//          • "standard" → run a bounded inline pass now and return the counts.
//        Same prompt, parse, and labels either way.
//
// A GUEST TAKES NEITHER PATH. POST reveals pairs the publish banked instead of
// generating any — see the carve-out in the POST body, phase 3 of
// docs/demo-cache-lab-plan.md — so the slider means "how many of these to
// uncover" rather than "how many to write".
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
import { bankCounts, revealBankedPairs } from "@/lib/demo/pairBank";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      // pairStats' own fields, plus what is left on the guest's shelf.
      //
      // WHY THE BANK COUNT RIDES HERE RATHER THAN IN PairStats. The panel sizes
      // its generate control from `questionsRemaining` — questions with NO pairs —
      // and after clone step 5e a guest has none of those, so a slider bounded by
      // it would never render and phase 3 would ship invisible. The guest's range
      // is a different quantity: how many pairs are still banked. Keeping it out
      // of PairStats keeps the shared type describing the pair TABLE, which is
      // what every other reader of it wants.
      //
      // Null, not zero, for a real account — the same distinction the two reveal
      // functions make: an account with no bank has no such control, while a guest
      // reading zero has emptied theirs.
      const counts = await bankCounts();
      return Response.json({
        ...(await pairStats()),
        bankedRemaining: counts?.pairs ?? null,
        bankedVerdicts: counts?.verdicts ?? null,
      });
    } catch (err) {
      return Response.json({ error: msg(err, "Failed to load pair stats.") }, { status: 500 });
    }
  });
}

const Body = z.object({
  // Caps the inline pass (and the batch build). Omitted = each path's own
  // default: bounded inline, the whole bank in batch. For a guest it is the
  // generate-count slider, i.e. how many BANKED pairs to reveal — see the
  // carve-out below.
  limit: z.number().int().positive().max(5000).optional(),
});

// How many banked pairs a guest's click reveals when the panel names no count.
// Small on purpose: the bank is 20 pairs (lib/demo/frozen's PAIR_BANK_CAP), and a
// default that emptied it in one press would turn a slider into a switch.
const DEFAULT_REVEAL = 5;

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    // THE DEMO GATE, WITH ONE CARVE-OUT — phase 3 of docs/demo-cache-lab-plan.md,
    // and the same shape `cachedOnly` has on /api/eval/bulk-generate: the only
    // form of this request that calls no model is the one that hands over work
    // somebody already paid for. Here that is lib/demo/clone step 5e's bank
    // (0078) — pairs the operator generated and F3 audited — and revealing one is
    // an INSERT of a row that already exists elsewhere, not a generation.
    //
    // THE CARVE-OUT IS THE FUNCTION, WHICH IS WHY IT CANNOT WIDEN. Unlike
    // `cachedOnly` there is no request flag to trust: revealBankedPairs returns
    // null for anyone who is not a guest, so a real account falls straight through
    // to the generator below with every path byte-for-byte as it was. It returns
    // null for a guest whose build banked nothing too — same null
    // readPublishedSweep returns — so that visitor reads DEMO_ACTIONS.pairs, the
    // fallback sentence written for exactly that build, instead of a 200 reporting
    // that nothing was revealed out of nothing.
    //
    // FAILS CLOSED. Delete this line and a guest hits the gate on the next one,
    // which is the pre-phase-3 behaviour; the gate itself is never conditional,
    // so scripts/guards.ts sweep 6 keeps meaning what it says.
    const reveal = await revealBankedPairs(body.data.limit ?? DEFAULT_REVEAL);
    if (reveal) {
      // No triggerProbeReplay here, and it would be inert if there were: it
      // self-checks demoBlocks() and returns rather than throws (probeReplayTrigger
      // ln 47). Phase 4 gives a guest probes ONE at a time behind their own action
      // — the bulk job stays blocked — so a reveal that fired the trigger would be
      // 40 embeddings nobody asked for, arriving from the button labelled "free".
      return Response.json({
        mode: "revealed",
        published: true,
        // The panel hangs REVEALED_PAIRS_NOTE on this (lib/demo/policy). The sweep
        // is banked, so the leaderboard above these counts cannot move whatever
        // they do — and a rising pair count over a frozen table reads as a bug in
        // the sweep unless something says otherwise.
        frozenLeaderboard: true,
        revealed: reveal.revealed,
        requested: reveal.requested,
        remaining: reveal.remaining,
        stats: await pairStats(),
      });
    }
    await assertDemoAllows("pairs");
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
