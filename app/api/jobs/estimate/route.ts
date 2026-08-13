// API route: POST /api/jobs/estimate
//
// "How long will this take, and should I offer to run it in the background?" —
// asked by the dashboard the moment a bulk action is clicked, before anything is
// started or spent.
//
// It counts units with the STEP'S OWN plan(), not with a query written here. That
// is the whole reason plan() is separate from run(): an estimate derived from a
// different count than the work iterates is a number that drifts away from the
// truth the first time either side changes.
//
// POST rather than GET because the scope is a structured payload (document ids,
// flags) that belongs in a body. Nothing is written.
import { z } from "zod";

import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { backgroundBlocker, stepFor } from "@/lib/jobs/registry";
import { backgroundThresholdSeconds, estimate } from "@/lib/jobs/timing";
import { JOB_KINDS, JOB_UNITS, type JobKind } from "@/lib/jobs/types";
import { emailConfigured } from "@/lib/notify/email";
import { requireUserForApi } from "@/lib/auth/dal";

const Body = z.object({
  kind: z.enum(JOB_KINDS),
  scope: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const kind = body.data.kind as JobKind;

  return withRequestConfig(request, async () => {
    const step = stepFor(kind);
    // Not wired for the background yet: answer honestly rather than 501-ing, so the
    // dashboard can still show "this will take a while" and simply not offer the
    // background for it.
    if (!step) {
      return Response.json({ kind, backgroundable: false, units: null, seconds: null });
    }
    // Wired, but refused under the current settings (autotune's apply='choose').
    // Answered the same way an unwired kind is: the dashboard still shows "this
    // will take a while", it just does not offer a background that would not work.
    const blocked = await backgroundBlocker(kind);
    if (blocked) {
      return Response.json({
        kind,
        backgroundable: false,
        blockedReason: blocked,
        units: null,
        seconds: null,
      });
    }
    const { totalUnits } = await step.plan((body.data.scope ?? {}) as never);
    const eta = await estimate(kind, totalUnits);
    const threshold = backgroundThresholdSeconds();
    // The address the promise in the dialog is about. requireUserForApi has
    // already run inside withRequestConfig; this is the same session's user.
    const user = await requireUserForApi();
    return Response.json({
      kind,
      unit: JOB_UNITS[kind],
      units: eta.units,
      seconds: eta.seconds,
      msPerUnit: eta.msPerUnit,
      source: eta.source,
      samples: eta.samples,
      thresholdSeconds: threshold,
      // The two things the offer depends on, answered by the server so the client
      // does not have to know either rule.
      offerBackground: eta.seconds > threshold,
      backgroundable: true,
      // Whether we can actually keep the "we'll email you" half of the promise.
      emailConfigured: emailConfigured(),
      email: user?.email ?? null,
    });
  });
}
