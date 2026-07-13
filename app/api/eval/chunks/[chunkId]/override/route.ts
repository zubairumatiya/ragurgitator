// ---------------------------------------------------------------------------
// API route: POST/DELETE /api/eval/chunks/[chunkId]/override
//
// Persist or clear a per-chunk override for the ACTIVE config (Phase 5 / Phase B):
//   POST { model }            — model override: re-embed the whole chunk under
//                               `model` and rank it in that model's space.
//   POST { size, overlap? }   — size override: re-split the chunk and rank it by
//                               its best piece (hit = any piece in top-k).
//   DELETE                    — clear whatever override the chunk has.
// Both are rank-fused with the base ANN (see lib/rag/retriever). Scoped to the
// active config. `params` is a Promise in this Next.js version.
//
// On success the CHANGED chunk's questions are re-scored inline (rescored: n in
// the response) so its rates reflect the new retrieval immediately; every other
// result goes retrieval-stale (badge + change log) until the next full run.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import {
  rescoreChunkQuestions,
  setChunkModelOverride,
  setChunkSizeModelOverride,
  setChunkSizeOverride,
} from "@/lib/rag/eval";
import { clearChunkOverride } from "@/lib/rag/overrideStore";

const Body = z
  .object({
    model: z.string().min(1).optional(),
    size: z.number().int().positive().optional(),
    overlap: z.number().int().min(0).optional(),
  })
  .refine((d) => d.model !== undefined || d.size !== undefined, {
    error: "Provide a `model`, or a `size` (+ optional `overlap`) for a size override.",
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
      // Size (or size+model combo) override when `size` is present.
      if (body.data.size !== undefined) {
        const status = body.data.model
          ? await setChunkSizeModelOverride(
              chunkId,
              body.data.size,
              body.data.overlap ?? 0,
              body.data.model,
            )
          : await setChunkSizeOverride(chunkId, body.data.size, body.data.overlap ?? 0);
        switch (status) {
          case "ok":
            return Response.json({ ok: true, rescored: await rescoreChunkQuestions(chunkId) });
          case "not-found":
            return Response.json(
              { error: "Chunk not found under the active config." },
              { status: 404 },
            );
          case "invalid":
            return Response.json(
              { error: "Invalid size/overlap (need size ≥ 1 and 0 ≤ overlap < size)." },
              { status: 400 },
            );
          case "unknown-model":
            return Response.json(
              { error: `Unknown model "${body.data.model}".` },
              { status: 400 },
            );
          case "unavailable":
            return Response.json(
              { error: `"${body.data.model}" isn't available — set its API key.` },
              { status: 400 },
            );
        }
      }

      const status = await setChunkModelOverride(chunkId, body.data.model!);
      switch (status) {
        case "ok":
          return Response.json({ ok: true, rescored: await rescoreChunkQuestions(chunkId) });
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
      return Response.json({ ok: true, rescored: await rescoreChunkQuestions(chunkId) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear override.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
