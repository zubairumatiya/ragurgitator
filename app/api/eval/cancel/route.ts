// API route: POST /api/eval/cancel
//
// Asks an in-flight NDJSON run to stop. Body: { runId } — the id the run
// announced on its first line (`run-started`). Not config-scoped: a run id
// already names one run belonging to one user, and the run itself is streaming
// under whatever config it started in.
//
// COOPERATIVE, AND PARTIAL WORK IS KEPT. This flips a flag; the run stops at its
// next checkpoint, which for an in-flight LLM call is when that call returns.
// The run then commits what it already generated rather than throwing, because
// the whole stream is one transaction — see lib/http/cancelRegistry.ts.
//
// `found: false` means the id is unknown: the run finished, never existed, or
// belongs to another user (deliberately indistinguishable, so this cannot probe
// for other people's run ids). The UI treats it as success — either way, that
// run is not going to spend anything more on this instance.
import { z } from "zod";

import { activeUserId } from "@/lib/auth/userScope";
import { parseBody } from "@/lib/http/body";
import { requestCancel } from "@/lib/http/cancelRegistry";
import { withRequestUser } from "@/lib/http/configScope";

const Body = z.object({
  runId: z.uuid({ error: "`runId` must be a uuid." }),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestUser(async () => {
    const found = requestCancel(body.data.runId, activeUserId());
    return Response.json({ ok: true, found });
  });
}
