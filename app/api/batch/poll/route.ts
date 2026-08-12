// API route: POST /api/batch/poll
//
// The "Check now" button and the panel's while-open poll. Advances the SIGNED-IN
// USER's active jobs one step (refresh provider status; apply on completion; email
// once) and returns their fresh list. Not config-scoped — a user's jobs span their
// configs, and each applies inside its OWN config scope.
//
// A session-bearing route despite feeling like a background job: it is driven by the
// UI panel, which is what lets the poller scope to an owner rather than sweeping the
// whole table.
import { pollAndApply } from "@/lib/batch/orchestrator";
import { withRequestUser } from "@/lib/http/configScope";

export async function POST() {
  return withRequestUser(async () => {
    try {
      const jobs = await pollAndApply();
      return Response.json({ jobs });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Poll failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
