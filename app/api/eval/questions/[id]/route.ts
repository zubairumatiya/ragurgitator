// ---------------------------------------------------------------------------
// API route: PATCH/DELETE /api/eval/questions/[id]
//
// Manual curation of the golden set. PATCH edits a question's text (marks it
// 'manual' and bumps updated_at, so it re-scores on the next run); DELETE
// removes it. `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { deleteQuestion, updateQuestion } from "@/lib/rag/evalStore";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const question =
    typeof body === "object" && body !== null && "question" in body
      ? (body as { question: unknown }).question
      : undefined;

  if (typeof question !== "string" || !question.trim()) {
    return Response.json(
      { error: "Provide a non-empty `question` string." },
      { status: 400 },
    );
  }

  try {
    await updateQuestion(id, question.trim());
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteQuestion(id);
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
