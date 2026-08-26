// API route: GET  /api/jobs — the signed-in user's background jobs, newest first.
//            POST /api/jobs — launch one ("run this in the background instead").
//
// The launch is config-scoped (the step's plan() counts units in the active
// config's corpus); the list is not, because a user's jobs span their configs and
// the panel shows them all.
import { z } from "zod";

import { parseBody } from "@/lib/http/body";
import { withRequestConfig, withRequestUser } from "@/lib/http/configScope";
import { launchJob } from "@/lib/jobs/runner";
import { activeJobsForConfig, listJobs } from "@/lib/jobs/store";
import { backgroundBlocker, isWired } from "@/lib/jobs/registry";
import { JOB_KINDS, JOB_LABELS, type JobKind } from "@/lib/jobs/types";
import { activeConfig } from "@/lib/rag/activeConfig";
import { assertDemoAllows, type DemoAction } from "@/lib/demo/policy";

// Which sentence a guest sees per job kind, or null for a kind the demo runs.
// Exhaustive by type, so a new kind cannot be added without deciding whether the
// demo may run it — which is the whole reason it is a Record and not a lookup with
// a default.
//
// re-score and autotune are null because phase 4 scopes them rather than blocking
// them (lib/demo/frozen): whichever driver runs the step, the step's question set
// is the twelve. bulk nDCG is not scoped — its cost is the aggregate ranking
// builder, which embeds a candidate pool under every model on the config's list —
// so the background door stays shut on exactly the kind the front door refuses.
const DEMO_ACTION_FOR_JOB: Record<JobKind, DemoAction | null> = {
  rescore: null,
  bulk_ndcg: "rank",
  autotune: null,
  // Blocked, unlike re-score and autotune, because there is no scoped version of
  // it: every probe is an embedding a guest did not pay for, and a background job
  // that spends is precisely what this table exists to stop. A guest's shadow
  // queue is stocked by lib/demo/clone step 5b instead, which is what the sentence
  // points at.
  probe_replay: "probeReplay",
};

export async function GET() {
  return withRequestUser(async () => Response.json({ jobs: await listJobs() }));
}

const Body = z.object({
  kind: z.enum(JOB_KINDS),
  // Whatever the step's scope type is — document ids and flags, validated by the
  // step rather than here, since this route is deliberately kind-agnostic.
  scope: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const kind = body.data.kind as JobKind;

  return withRequestConfig(request, async () => {
    // THE ONE GATE THAT COVERS EVERY LEVER. Re-score, bulk nDCG and autotune each
    // have an NDJSON twin gated at its own route; this is the other door into the
    // same work, and it would be the one nobody remembered. Probe replay has no
    // twin at all — its only doors are this one and pair generation — so for that
    // kind this is not the second gate but the first.
    const demoAction = DEMO_ACTION_FOR_JOB[kind];
    if (demoAction) await assertDemoAllows(demoAction);
    if (!isWired(kind)) {
      return Response.json(
        { error: `${JOB_LABELS[kind]} cannot run in the background yet.` },
        { status: 501 },
      );
    }
    // Wired, but not under these settings — currently only autotune's
    // apply='choose', which needs a tab open to collect the choices. Refused here
    // as well as hidden by the estimate route, since the estimate is advisory and
    // this is the door.
    const blocked = await backgroundBlocker(kind);
    if (blocked) return Response.json({ error: blocked.reason }, { status: 409 });
    // One job of a kind per config at a time. Two concurrent re-scores of the same
    // corpus would interleave their result rows and both freeze a snapshot of a
    // corpus the other was still rewriting — and the user gets two emails saying
    // different things about the same run.
    const running = await activeJobsForConfig(activeConfig().id, [kind]);
    if (running.length > 0) {
      return Response.json(
        { error: `${JOB_LABELS[kind]} is already running on this config.`, job: running[0] },
        { status: 409 },
      );
    }
    const job = await launchJob(kind, body.data.scope ?? {});
    return Response.json({ job }, { status: 202 });
  });
}
