// API route: POST /api/batch/ack
//
// Dismisses the "something finished" badge for EVERY terminal, undismissed job the
// signed-in user has — the bulk sibling of PATCH /api/batch/[id] { action: "ack" },
// fired when the status panel is opened. Opening the panel is the user seeing the
// jobs, so the dot clearing is the honest reading.
//
// BOTH KINDS, because the badge counts both. This route acked only provider
// batches for as long as background jobs existed, so a finished background run lit
// a green dot that no amount of opening the panel could clear — jobStore's
// acknowledgeAllTerminal was written to mirror this one and then never called.
// The panel is one panel; "I saw it" cannot mean half of it.
//
// A write, so POST rather than GET: opening the panel changes server state, and
// nothing should be able to trigger it by prefetching a URL.
import { withRequestUser } from "@/lib/http/configScope";
import { acknowledgeAllTerminal } from "@/lib/rag/batchStore";
import { acknowledgeAllTerminal as acknowledgeAllTerminalJobs } from "@/lib/jobs/store";

export async function POST() {
  return withRequestUser(async () => {
    // One flat list of ids: the client applies it to both of its lists, and job
    // ids are uuids from two tables that never collide.
    const [batches, jobs] = await Promise.all([
      acknowledgeAllTerminal(),
      acknowledgeAllTerminalJobs(),
    ]);
    return Response.json({ acknowledged: [...batches, ...jobs] });
  });
}
