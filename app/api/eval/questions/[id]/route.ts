// API route: PATCH/DELETE /api/eval/questions/[id]
//
// Manual curation of the golden set. PATCH edits a question's text (marks it
// 'manual' and bumps updated_at, so it re-scores on the next run); DELETE
// removes it, and with `?uncache=1` also unbanks it from question_cache so it
// doesn't return via "Add cached". A query param rather than a body: DELETE
// bodies are awkward and parseBody here is built for POST/PATCH.
// `params` is a Promise in this Next.js version — await it.
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { deleteQuestion, updateQuestion } from "@/lib/rag/evalStore";
import { uncacheQuestion } from "@/lib/rag/questionCache";

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
      const updated = await updateQuestion(id, body.data.question);
      if (!updated) {
        return Response.json({ error: "Question not found." }, { status: 404 });
      }
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
  const uncache = new URL(request.url).searchParams.get("uncache") === "1";
  return withRequestConfig(request, async () => {
    try {
      const deleted = await deleteQuestion(id);
      if (!deleted) {
        return Response.json({ error: "Question not found." }, { status: 404 });
      }
      if (!uncache) return Response.json({ ok: true });
      // No chunk text = nothing to key the bank lookup on (chunk table gone, or
      // the label was orphaned). Report it rather than claiming a clean uncache.
      if (deleted.chunkText === null) {
        return Response.json({ ok: true, uncached: 0, uncacheFailed: true });
      }
      const uncached = await uncacheQuestion(deleted.chunkText, deleted.question);
      return uncached === null
        ? Response.json({ ok: true, uncached: 0, uncacheFailed: true })
        : Response.json({ ok: true, uncached });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
