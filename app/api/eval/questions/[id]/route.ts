// ---------------------------------------------------------------------------
// API route: PATCH/DELETE /api/eval/questions/[id]
//
// Manual curation of the golden set. PATCH edits a question's text (marks it
// 'manual' and bumps updated_at, so it re-scores on the next run); DELETE
// removes it. `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { deleteQuestion, updateQuestion } from "@/lib/rag/evalStore";

const Body = z.object({
  question: requiredTrimmedString("Provide a non-empty `question` string."),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    try {
      await updateQuestion(id, body.data.question);
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRequestConfig(request, async () => {
    try {
      await deleteQuestion(id);
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
