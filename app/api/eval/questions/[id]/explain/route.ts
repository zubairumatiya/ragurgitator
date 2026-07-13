// ---------------------------------------------------------------------------
// API route: GET /api/eval/questions/[id]/explain
//
// Drill-down for one question: the ground-truth chunk plus what the latest
// scoring run actually retrieved (in rank order). Backs the expandable "why did
// it miss?" panel on /eval — fetched lazily on expand so the main summary stays
// lean. `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { getQuestionExplain } from "@/lib/rag/evalStore";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // ?state=baseline narrows to results scored under pure base-model retrieval
  // (0022 fingerprint) — the baseline row's top-k while a delegate is active.
  const state = new URL(request.url).searchParams.get("state") ?? undefined;
  return withRequestConfig(request, async () => {
    try {
      const explain = await getQuestionExplain(id, state);
      return Response.json(explain);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load chunk detail.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
