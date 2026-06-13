// ---------------------------------------------------------------------------
// API route: POST /api/eval/questions
//
// Add a hand-written eval question labeled to a specific chunk (under the active
// config). Body: { chunkId: string, question: string }. The new question is
// unscored until the next "Process new chunks" / "Re-score all". Backs the
// "Add a question" form on each chunk group in /eval.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import { addManualQuestion } from "@/lib/rag/evalStore";

const Body = z.object({
  chunkId: z.string({ error: "Provide a `chunkId`." }).min(1, { error: "Provide a `chunkId`." }),
  question: requiredTrimmedString("Provide a non-empty `question` string."),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  try {
    const ok = await addManualQuestion(body.data.chunkId, body.data.question);
    if (!ok) {
      return Response.json(
        { error: "Chunk not found under the active config." },
        { status: 404 },
      );
    }
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add question.";
    return Response.json({ error: message }, { status: 500 });
  }
}
