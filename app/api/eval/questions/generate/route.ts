// ---------------------------------------------------------------------------
// API route: POST /api/eval/questions/generate
//
// Author one synthetic eval question for a specific chunk (under the active
// config) at a target difficulty. Body: { chunkId: string, difficulty:
// 'easy' | 'medium' | 'hard' }. The new question lands unscored until the next
// "Process new chunks" / "Re-score all". Backs the synthetic side of the
// "Add a question" form on each chunk group in /eval.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { generateQuestionForChunk, type Difficulty } from "@/lib/rag/eval";

// `satisfies` rejects any entry that isn't a real Difficulty while keeping the
// literal tuple type that z.enum needs. (It can't catch a *missing* level —
// update this list when Difficulty grows.)
const DIFFICULTIES = ["easy", "medium", "hard"] as const satisfies readonly Difficulty[];

const Body = z.object({
  chunkId: z.string({ error: "Provide a `chunkId`." }).min(1, { error: "Provide a `chunkId`." }),
  difficulty: z.enum(DIFFICULTIES, {
    error: "Provide a `difficulty` of 'easy', 'medium', or 'hard'.",
  }),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  try {
    const result = await generateQuestionForChunk(body.data.chunkId, body.data.difficulty);
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
