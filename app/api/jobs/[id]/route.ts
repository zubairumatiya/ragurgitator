// API route: GET/PATCH /api/jobs/[id]
//
// GET returns one job (the panel's detail poll). PATCH is the three things a user
// can do to a running job:
//
//   cancel      — writes the DURABLE cancel flag. The running slice notices at its
//                 next checkpoint and stops, keeping everything it had already
//                 committed. This is the cross-instance cancel that
//                 lib/http/cancelRegistry.ts (process-local) cannot provide.
//   resume      — re-tick a job that looks stuck. Always safe: a job that is
//                 genuinely running holds a lease, so the tick finds it busy and
//                 does nothing.
//   acknowledge — dismiss the finished-job badge.
//
// `params` is a Promise in this Next.js version — await it.
import { z } from "zod";

import { parseBody } from "@/lib/http/body";
import { withRequestUser } from "@/lib/http/configScope";
import { resumeJob } from "@/lib/jobs/runner";
import { acknowledgeJob, getJob, requestCancel } from "@/lib/jobs/store";

const Body = z.object({
  action: z.enum(["cancel", "resume", "acknowledge"], {
    error: "`action` must be one of cancel, resume, acknowledge.",
  }),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestUser(async () => {
    const job = await getJob(id);
    if (!job) return Response.json({ error: "Job not found." }, { status: 404 });
    return Response.json({ job });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestUser(async () => {
    const job =
      body.data.action === "cancel"
        ? await requestCancel(id)
        : body.data.action === "resume"
          ? await resumeJob(id)
          : await acknowledgeJob(id);
    if (!job) return Response.json({ error: "Job not found." }, { status: 404 });
    return Response.json({ job });
  });
}
