// API route: GET /api/eval/autotune/holdout/[runId]
//
// One run's per-question held-out detail — the rows behind its headline, so
// "which held-out questions still miss" is answerable from the UI instead of
// from a script. Fetched lazily when a history row is expanded; the list route
// deliberately does not carry it, since a config with 20 runs of 118 held-out
// questions would ship 2,360 rows to render a collapsed section.
//
// `params` is a Promise in this Next.js version — await it.
import { withRequestConfig } from "@/lib/http/configScope";
import { listHoldoutRunQuestions } from "@/lib/rag/autotuneStore";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  return withRequestConfig(request, async () => {
    try {
      // Config-scoped through the run row, so another config's run id comes back
      // empty rather than 404 — the row is not missing, it is not yours.
      return Response.json({ questions: await listHoldoutRunQuestions(runId) });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load held-out questions.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
