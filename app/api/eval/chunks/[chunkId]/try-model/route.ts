// ---------------------------------------------------------------------------
// API route: /api/eval/chunks/[chunkId]/try-model
//
// The per-chunk "try a different model" experiment (see lib/rag/eval):
//   - GET    : context for the trial UI — the chunk, its questions + stored
//              baseline, the auto candidate pool, the rest of the corpus to pick
//              from, the models on offer, and any saved trials.
//   - POST   : run a trial { model?, size?, overlap?, sections?, poolChunkIds,
//              save? } — re-rank the chunk's questions within the re-embedded
//              pool under the variation (model, chunk shape, or both). With
//              save:true the snapshot is persisted (eval_model_trials).
//   - DELETE : remove a saved trial (?trialId=...).
//
// Ranking is ephemeral and in-memory; the live index is never touched. `params`
// is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { altEmbeddingModels } from "@/lib/config";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import {
  getModelTrialContext,
  runModelTrial,
  type TrialVariation,
} from "@/lib/rag/eval";
import { deleteModelTrial } from "@/lib/rag/evalStore";

const MODEL_ERROR = "`model` must be one of the offered alternate models.";

// "Try a different configuration": vary the model, the chunk's shape (uniform
// size/overlap or custom sections), or both. At least one knob must be present;
// a shape-only body runs under the config's baseline model.
const Body = z
  .object({
    model: z
      .string({ error: MODEL_ERROR })
      .refine((m) => altEmbeddingModels.some((alt) => alt.id === m), {
        error: MODEL_ERROR,
      })
      .optional(),
    size: z.number({ error: "`size` must be a positive integer." }).int().positive().optional(),
    overlap: z.number({ error: "`overlap` must be a non-negative integer." }).int().min(0).optional(),
    sections: z
      .array(z.string().min(1), { error: "`sections` must be an array of non-empty strings." })
      .min(1)
      .optional(),
    poolChunkIds: z
      .array(z.string({ error: "`poolChunkIds` must be an array of chunk id strings." }), {
        error: "`poolChunkIds` must be an array of chunk id strings.",
      })
      .default([]),
    save: z.boolean({ error: "`save` must be a boolean." }).default(false),
  })
  .refine((d) => d.model !== undefined || d.size !== undefined || d.sections !== undefined, {
    error: "Provide a `model`, a `size` (+ optional `overlap`), and/or `sections`.",
  });

// Map the flat body to the engine's variation union.
function toVariation(d: z.infer<typeof Body>): TrialVariation {
  const hasShape = d.size !== undefined || d.sections !== undefined;
  if (d.model !== undefined && hasShape) {
    return { kind: "size+model", model: d.model, size: d.size, overlap: d.overlap, sections: d.sections };
  }
  if (d.model !== undefined) return { kind: "model", model: d.model };
  return { kind: "size", size: d.size, overlap: d.overlap, sections: d.sections };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const { chunkId } = await params;
  return withRequestConfig(request, async () => {
    try {
      const context = await getModelTrialContext(chunkId);
      if (!context) {
        return Response.json(
          { error: "Chunk not found under the active config." },
          { status: 404 },
        );
      }
      return Response.json(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load trial context.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  const { chunkId } = await params;

  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const { poolChunkIds, save } = body.data;

  return withRequestConfig(request, async () => {
    try {
      const out = await runModelTrial(chunkId, toVariation(body.data), poolChunkIds, save);
      if (!out) {
        return Response.json(
          { error: "Chunk not found, or it has no questions to evaluate." },
          { status: 404 },
        );
      }
      return Response.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Model trial failed.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ chunkId: string }> },
) {
  await params; // chunkId isn't needed — trials are deleted by their own id
  const trialId = new URL(request.url).searchParams.get("trialId");
  if (!trialId) {
    return Response.json({ error: "Provide a `trialId` query param." }, { status: 400 });
  }
  return withRequestConfig(request, async () => {
    try {
      const ok = await deleteModelTrial(trialId);
      if (!ok) return Response.json({ error: "Trial not found." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete trial.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
