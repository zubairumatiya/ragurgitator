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
    if (blocked) return Response.json({ error: blocked }, { status: 409 });
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
