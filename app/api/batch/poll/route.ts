// ---------------------------------------------------------------------------
// API route: POST /api/batch/poll
//
// The "Check now" button and the panel's while-open poll. Advances every active
// job one step (refresh provider status; apply on completion; email once) and
// returns the fresh account-wide list. Not config-scoped — jobs are global and
// each applies inside its OWN config scope (resolved by the orchestrator).
// ---------------------------------------------------------------------------
import { pollAndApply } from "@/lib/batch/orchestrator";

export async function POST() {
  try {
    const jobs = await pollAndApply();
    return Response.json({ jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Poll failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
