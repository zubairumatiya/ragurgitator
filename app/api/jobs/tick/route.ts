// API route: POST /api/jobs/tick — advance one background job by one slice.
//              GET  /api/jobs/tick — the cron backstop: sweep everyone's stalled jobs.
//
// THE ONLY ROUTE IN THE APP WITH NO USER SESSION. It cannot have one: a tick is
// fired by a function that is about to be killed, or by Vercel's cron, and neither
// holds a cookie. lib/http/jobSecret.ts is the boundary instead, and the route's
// authority is deliberately minimal — a valid tick says "advance THIS job", and
// whose job it is comes from the row, not the caller.
//
// WHY IT ANSWERS BEFORE IT WORKS. The slice runs inside `after()`, so the response
// goes out in milliseconds and the caller — usually the previous, dying slice —
// learns the handoff landed without waiting out the next four minutes. The work
// then runs on THIS invocation's clock, which is the whole point of chaining:
// every slice gets a fresh maxDuration budget rather than sharing one.
import { after } from "next/server";

import { withJobSecret } from "@/lib/http/jobSecret";
import { demoEnabled } from "@/lib/demo/config";
import { runDemoHousekeeping } from "@/lib/demo/housekeeping";
import { runSlice, sweepStalledJobsAcrossUsers } from "@/lib/jobs/runner";

// Vercel kills a function at this many seconds (Hobby's ceiling; Pro allows more).
// JOBS_SLICE_BUDGET_MS in lib/jobs/runner.ts must stay comfortably under it — the
// slice has to checkpoint and chain before the platform pulls the plug.
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { jobId?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : null;
  if (!jobId) return Response.json({ error: "`jobId` is required." }, { status: 400 });

  return withJobSecret(request, jobId, async () => {
    // Scheduled, not awaited — see the header. A slice that throws is already
    // handled inside runSlice (the job is marked failed); this catch is only for
    // the truly unexpected, and must not take the invocation down with it.
    after(async () => {
      try {
        await runSlice(jobId);
      } catch (e) {
        console.warn(`[jobs] tick for ${jobId} threw: ${String(e)}`);
      }
    });
    return Response.json({ accepted: true, jobId }, { status: 202 });
  });
}

// The cron backstop. On Vercel Hobby this can only fire once a day, which is why
// it is the LAST line of defence and not the mechanism: the chain handles the
// normal case, the panel's poll handles a break while someone is looking, and this
// handles a break while nobody is.
export async function GET(request: Request) {
  return withJobSecret(request, null, async () => {
    const nudged = await sweepStalledJobsAcrossUsers();
    // THE DEMO'S HOUSEKEEPING RIDES ALONG, rather than taking a cron slot of its
    // own: Vercel's Hobby plan allows few of them, and both jobs want exactly
    // the same schedule and the same boundary. Guests are normally reaped at
    // provisioning time (which is what makes a two-hour TTL mean two hours);
    // this covers the quiet day where nobody arrives, and carries the HNSW
    // reindex, which nothing else can do (lib/demo/housekeeping.ts).
    //
    // Best-effort by construction — a failure here must not stop the janitor
    // sweep that is this route's actual job.
    const demo = demoEnabled()
      ? await runDemoHousekeeping().catch((e) => {
          console.warn(`[demo] housekeeping failed: ${String(e)}`);
          return null;
        })
      : null;
    return Response.json({ nudged, demo });
  });
}
