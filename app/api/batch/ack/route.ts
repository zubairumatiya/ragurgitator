// API route: POST /api/batch/ack
//
// Dismisses the "a batch finished" badge for EVERY terminal, undismissed job the
// signed-in user has — the bulk sibling of PATCH /api/batch/[id] { action: "ack" },
// fired when the status panel is opened. Opening the panel is the user seeing the
// jobs, so the dot clearing is the honest reading.
//
// A write, so POST rather than GET: opening the panel changes server state, and
// nothing should be able to trigger it by prefetching a URL.
import { withRequestUser } from "@/lib/http/configScope";
import { acknowledgeAllTerminal } from "@/lib/rag/batchStore";

export async function POST() {
  return withRequestUser(async () => {
    const acknowledged = await acknowledgeAllTerminal();
    return Response.json({ acknowledged });
  });
}
