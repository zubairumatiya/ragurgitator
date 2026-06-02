// ---------------------------------------------------------------------------
// API route: POST /api/eval/rescore
//
// Re-runs retrieval scoring for EVERY labeled question under the active config
// (not just unscored ones) against the current corpus, inserts fresh result rows,
// and freezes a run snapshot. Use after the corpus changes (e.g. a doc was added)
// so Recall@k stays apples-to-apples. Backs the "Re-score all" button on /eval.
// ---------------------------------------------------------------------------
import { rescoreAllQuestions } from "@/lib/rag/eval";

export async function POST() {
  try {
    const result = await rescoreAllQuestions();
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Re-scoring failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
