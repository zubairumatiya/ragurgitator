// ---------------------------------------------------------------------------
// API route: PATCH /api/batch/[id]
//
// Two per-job actions (jobs are account-wide, addressed by id — no config scope):
//   { action: "cancel" } — provider cancel + local status → canceling.
//                          (No-op unless the job is still in_progress.)
//   { action: "ack" }    — dismiss the in-app "done" toast (acknowledged=true).
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { cancelJob } from "@/lib/batch/orchestrator";
import { acknowledgeJob } from "@/lib/rag/batchStore";

const Body = z.object({ action: z.enum(["cancel", "ack"]) });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  try {
    const job = body.data.action === "cancel" ? await cancelJob(id) : await acknowledgeJob(id);
    if (!job) return Response.json({ error: "Batch job not found." }, { status: 404 });
    return Response.json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Action failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
