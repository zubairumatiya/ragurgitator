// API route: POST /api/jobs/poll
//
// The panel's while-open poll, and the janitor's main trigger. Two things in one
// round trip: nudge any of this user's jobs that should be advancing but hold no
// live lease, then return the fresh list.
//
// Coupling the sweep to the poll is the honest design for Vercel Hobby, where cron
// fires once a day: having the app open IS the recovery mechanism, and a broken
// chain heals the moment someone looks. It costs nothing when nothing is stalled —
// a healthy job holds a lease and is invisible to the sweep.
//
// Deliberately mirrors POST /api/batch/poll, which does the same for provider
// batches; the panel calls both.
import { withRequestUser } from "@/lib/http/configScope";
import { sweepStalledJobs } from "@/lib/jobs/runner";
import { listJobs } from "@/lib/jobs/store";

export async function POST() {
  return withRequestUser(async () => {
    try {
      const nudged = await sweepStalledJobs();
      return Response.json({ jobs: await listJobs(), nudged: nudged.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Poll failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
