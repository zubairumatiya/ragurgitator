// ---------------------------------------------------------------------------
// API route: POST /api/eval/questions/generate
//
// Author one synthetic eval question for a specific chunk (under the active
// config) at a target difficulty. Body: { chunkId: string, difficulty:
// 'easy' | 'medium' | 'hard' }. The new question lands unscored until the next
// "Process new chunks" / "Re-score all". Backs the synthetic side of the
// "Add a question" form on each chunk group in /eval.
// ---------------------------------------------------------------------------
import { generateQuestionForChunk, type Difficulty } from "@/lib/rag/eval";

const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

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
  const difficulty =
    typeof body === "object" && body !== null && "difficulty" in body
      ? (body as { difficulty: unknown }).difficulty
      : undefined;

  if (typeof chunkId !== "string" || !chunkId) {
    return Response.json({ error: "Provide a `chunkId`." }, { status: 400 });
  }
  if (!DIFFICULTIES.includes(difficulty as Difficulty)) {
    return Response.json(
      { error: "Provide a `difficulty` of 'easy', 'medium', or 'hard'." },
      { status: 400 },
    );
  }

  try {
    const result = await generateQuestionForChunk(chunkId, difficulty as Difficulty);
    if (result === "not-found") {
      return Response.json(
        { error: "Chunk not found under the active config." },
        { status: 404 },
      );
    }
    if (result === "empty") {
      return Response.json(
        { error: "The model didn't return a usable question — try again." },
        { status: 502 },
      );
    }
    return Response.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to generate question.";
    return Response.json({ error: message }, { status: 500 });
  }
}
