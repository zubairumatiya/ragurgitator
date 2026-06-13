// ---------------------------------------------------------------------------
// API route: POST /api/chat
//
// Body: { question: string }
// Reply: { answer: string, sources: RetrievedChunk[] }
//
// All RAG logic lives in pipeline.ask — this route just translates HTTP.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import { ask } from "@/lib/rag/pipeline";

const Body = z.object({
  question: requiredTrimmedString("Provide a non-empty `question` string."),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  try {
    const result = await ask(body.data.question);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
