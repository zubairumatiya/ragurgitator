// ---------------------------------------------------------------------------
// API route: POST /api/chat
//
// Body: { question: string }
// Reply: { answer: string, sources: RetrievedChunk[] }
//
// All RAG logic lives in pipeline.ask — this route just translates HTTP.
// ---------------------------------------------------------------------------
import { ask } from "@/lib/rag/pipeline";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Expected a JSON body." },
      { status: 400 },
    );
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
    const result = await ask(question);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
