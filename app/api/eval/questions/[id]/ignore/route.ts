// ---------------------------------------------------------------------------
// API route: POST /api/eval/questions/[id]/ignore
//
// Manual false-positive mode (eval-autotuning-plan §7): mark / unmark one
// question "ignore in rates" under the ACTIVE config. Ignored questions are
// excluded from the Recall/nDCG aggregates, the min-rate pass/fail counts, and
// autotune targeting, but still render (greyed) so the decision stays visible
// and reversible. `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { setQuestionIgnored } from "@/lib/rag/autotuneStore";

const Body = z.object({
  ignored: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    try {
      await setQuestionIgnored(id, body.data.ignored, body.data.reason ?? null);
      return Response.json({ ok: true, ignored: body.data.ignored });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
