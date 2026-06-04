// ---------------------------------------------------------------------------
// API route: POST /api/eval/questions
//
// Add a hand-written eval question labeled to a specific chunk (under the active
// config). Body: { chunkId: string, question: string }. The new question is
// unscored until the next "Process new chunks" / "Re-score all". Backs the
// "Add a question" form on each chunk group in /eval.
// ---------------------------------------------------------------------------
import { addManualQuestion } from "@/lib/rag/evalStore";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const chunkId =
    typeof body === "object" && body !== null && "chunkId" in body
      ? (body as { chunkId: unknown }).chunkId
      : undefined;
  const question =
    typeof body === "object" && body !== null && "question" in body
      ? (body as { question: unknown }).question
      : undefined;

  if (typeof chunkId !== "string" || !chunkId) {
    return Response.json({ error: "Provide a `chunkId`." }, { status: 400 });
  }
  if (typeof question !== "string" || !question.trim()) {
    return Response.json(
      { error: "Provide a non-empty `question` string." },
      { status: 400 },
    );
  }

  try {
    const ok = await addManualQuestion(chunkId, question.trim());
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
