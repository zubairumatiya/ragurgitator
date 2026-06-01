// ---------------------------------------------------------------------------
// API route: POST /api/eval/process
//
// Generates questions for any new chunks, scores anything unscored, and freezes
// a run snapshot. Incremental — only new/edited work is done. Backs the
// "Process new chunks" button on /eval.
// ---------------------------------------------------------------------------
import { processNewChunks } from "@/lib/rag/eval";

export async function POST() {
  try {
    const result = await processNewChunks();
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eval processing failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
