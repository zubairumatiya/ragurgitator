// API route: POST /api/chat
//
// Body: { question: string }
// Reply: { answer, sources: RetrievedChunk[], documents: Record<uuid, fileName> }
//
// All RAG logic lives in pipeline.ask — this route just translates HTTP. The
// `documents` map is the one thing added on top: a RetrievedChunk knows only its
// documentId, and a source card that shows a raw UUID tells the user nothing.
// Resolved here rather than inside the pipeline so the cache-hit path (whose stored
// sources also replay with ids only) gets the names for free.
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ask } from "@/lib/rag/pipeline";
import { documentFileNames } from "@/lib/rag/vectorStore";

const Body = z.object({
  question: requiredTrimmedString("Provide a non-empty `question` string."),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    try {
      const result = await ask(body.data.question);
      const documents = await documentFileNames(
        result.sources.map((s) => s.chunk.chunk.documentId),
      );
      return Response.json({ ...result, documents });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
