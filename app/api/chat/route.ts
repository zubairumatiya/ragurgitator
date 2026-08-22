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
import { isGuest } from "@/lib/demo/guest";
import { DEMO_BLOCKED } from "@/lib/demo/policy";
import { isMissingProviderKey } from "@/lib/llm/client";
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
      // A MISSING ANSWER-MODEL KEY IS THE DEMO'S NORMAL MISS, not a failure.
      //
      // A guest holds a Voyage key and nothing else, so a question the semantic
      // cache cannot answer reaches generation and throws here. The default
      // wording — "add a key on the Account page" — is a dead end for someone
      // with no account, so say what actually happened and point them back at
      // the questions that do work.
      if (isMissingProviderKey(err)) {
        if (await isGuest()) {
          return Response.json(
            {
              error:
                "The demo has no answer-model key, so it can only serve questions it " +
                "already has a banked answer for. Try one of the suggestions — or " +
                "rephrase; the cache matches on meaning, not wording.",
              code: DEMO_BLOCKED,
            },
            { status: 400 },
          );
        }
        // Rethrown rather than 500'd: catchingMissingKey turns it into the 400
        // that names the provider and carries the code the client keys off.
        throw err;
      }
      const message = err instanceof Error ? err.message : "Chat failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
