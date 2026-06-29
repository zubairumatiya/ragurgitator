// ---------------------------------------------------------------------------
// API route: POST/DELETE /api/eval/chunks/[chunkId]/override
//
// Persist (POST { model }) or clear (DELETE) a per-chunk embedding-model override
// for the ACTIVE config — promoting the ephemeral "try a different model" result
// (Phase 5). POST re-embeds the chunk's text under `model` and stores it;
// retrieval then ranks this chunk in that model's space, RRF-fused with the base
// model (see lib/rag/retriever). Scoped to the active config, so wrapped in
// withRequestConfig. `params` is a Promise in this Next.js version.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { setChunkModelOverride } from "@/lib/rag/eval";
import { clearChunkOverride } from "@/lib/rag/overrideStore";

const Body = z.object({
  model: z.string({ error: "Provide a `model`." }).min(1, { error: "Provide a `model`." }),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const { chunkId } = await params;
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    try {
      const status = await setChunkModelOverride(chunkId, body.data.model);
      switch (status) {
        case "ok":
          return Response.json({ ok: true });
        case "not-found":
          return Response.json(
            { error: "Chunk not found under the active config." },
            { status: 404 },
          );
        case "unknown-model":
          return Response.json({ error: `Unknown model "${body.data.model}".` }, { status: 400 });
        case "unavailable":
          return Response.json(
            { error: `"${body.data.model}" isn't available — set its API key.` },
            { status: 400 },
          );
        case "is-base":
          return Response.json(
            { error: "That's already the config's base model — clear the override instead." },
            { status: 400 },
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to set override.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const { chunkId } = await params;
  return withRequestConfig(request, async () => {
    try {
      const cleared = await clearChunkOverride(chunkId);
      if (!cleared) return Response.json({ error: "No override to clear." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear override.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
