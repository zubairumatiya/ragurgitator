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
// A GUEST TAKES NEITHER PATH. Both verbs read the banked similarity matrix
// instead — see the carve-outs below, phase 3 of docs/demo-cache-replay-plan.md —
// so the slider means "how far into the operator's own measurement to walk"
// rather than "how many pairs to write", and every number downstream of it moves
// with it.
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
import { advanceReplay, replayBankCounts } from "@/lib/demo/replayView";

const msg = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    try {
      // pairStats' own fields, with the guest's replayed counts over the top.
      //
      // WHY THE REPLAY OVERRIDES RATHER THAN REPLACES. Four of these numbers
      // describe the PAIR SET, and for a guest that set is the first `n` rows of
      // the banked matrix rather than whatever the clone happened to leave in
      // their pair table. The other three describe the config's EVAL BANK — the
      // gap, and whose config it is — which is live for a guest like everyone
      // else, and which nothing in the matrix could answer.
      //
      // WHY THE CEILING RIDES OUTSIDE PairStats. The panel sizes its generate
      // control from `questionsRemaining` — questions with NO pairs — and a guest
      // has none of those, so a slider bounded by it would never render. Their
      // range is a different quantity: how much of the matrix is still ahead.
      // Keeping it out of PairStats keeps the shared type describing the pair
      // TABLE, which is what every other reader of it wants.
      //
      // Null, not zero, for a real account — the same distinction every function
      // in replayView makes: an account with no matrix has no such control, while
      // a guest reading zero has walked to the end of theirs.
      const stats = await pairStats();
      const bank = await replayBankCounts();
      return Response.json({
        ...stats,
        ...(bank
          ? {
              total: bank.total,
              same: bank.same,
              different: bank.different,
              quarantined: bank.quarantined,
              unjudged: bank.unscreened,
            }
          : {}),
        bankedRemaining: bank?.remaining ?? null,
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

// How far a guest's click walks into the matrix when the panel names no count.
// Small on purpose: a default that reached the end of a ~186-pair matrix in one
// press would turn a slider into a switch.
const DEFAULT_REVEAL = 5;

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    // THE DEMO GATE, WITH ONE CARVE-OUT — phase 3 of docs/demo-cache-replay-plan.md,
    // and the same shape `cachedOnly` has on /api/eval/bulk-generate: the only
    // form of this request that calls no model is the one that hands over work
    // somebody already paid for. Here that is the banked similarity matrix
    // (0080) — the cosines under the operator's own leaderboard — and advancing
    // into it is arithmetic over numbers already bought, not a generation.
    //
    // THE CARVE-OUT IS THE FUNCTION, WHICH IS WHY IT CANNOT WIDEN. Unlike
    // `cachedOnly` there is no request flag to trust: advanceReplay returns null
    // for anyone who is not a guest, so a real account falls straight through to
    // the generator below with every path byte-for-byte as it was. It returns null
    // for a guest whose build banked nothing too — same null readPublishedSweep
    // returns — so that visitor reads DEMO_ACTIONS.pairs, the fallback sentence
    // written for exactly that build, instead of a 200 reporting that nothing was
    // revealed out of nothing.
    //
    // FAILS CLOSED. Delete this line and a guest hits the gate on the next one,
    // which is the pre-phase-3 behaviour; the gate itself is never conditional,
    // so scripts/guards.ts sweep 6 keeps meaning what it says.
    const advanced = await advanceReplay(body.data.limit ?? DEFAULT_REVEAL);
    if (advanced) {
      // No triggerProbeReplay here, and it would be inert if there were: it
      // self-checks demoBlocks() and returns rather than throws (probeReplayTrigger
      // ln 47). The demo has no probe of its own any more — the one live thing
      // that needed real pair text to embed — so a trigger fired here would be 40
      // embeddings nobody asked for, arriving from the button labelled "free".
      return Response.json({
        mode: "revealed",
        published: true,
        revealed: advanced.revealed,
        requested: advanced.requested,
        remaining: advanced.remaining,
        // The pair-set half is the matrix's, the gap half is the config's. Same
        // composition the GET performs, and it has to be: the panel replaces its
        // whole counts state from this payload, so a `stats` that reverted to the
        // pair table would undo the numbers the click just moved until the next
        // GET landed on top of it.
        stats: {
          ...(await pairStats()),
          total: advanced.bank.total,
          same: advanced.bank.same,
          different: advanced.bank.different,
          quarantined: advanced.bank.quarantined,
          unjudged: advanced.bank.unscreened,
        },
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
