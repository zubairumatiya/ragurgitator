// ---------------------------------------------------------------------------
// API route: POST /api/eval/questions/[id]/rechunk
//
// Ephemeral per-chunk "what-if". Two modes, by request body:
//   - Mode A (uniform sub-divide): { size, overlap } — re-split the chunk at a
//     trial size/overlap.
//   - Mode B (custom boundaries):  { sections: string[] } — replace the chunk
//     with the supplied reshaped section text(s).
// Both re-rank the question with that chunk swapped out; nothing is persisted
// (see lib/rag/eval). `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { invalidBody, readJsonBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import {
  runCustomChunkExperiment,
  runRechunkExperiment,
  type RechunkResult,
} from "@/lib/rag/eval";

// Mode B. Validated with refine rather than .trim() so the section text reaches
// the experiment exactly as sent — whitespace is part of the chunk boundaries.
const SECTIONS_ERROR = "`sections` must be a non-empty array of non-empty strings.";
const SectionsBody = z.object({
  sections: z
    .array(
      z
        .string({ error: SECTIONS_ERROR })
        .refine((s) => s.trim().length > 0, { error: SECTIONS_ERROR }),
      { error: SECTIONS_ERROR },
    )
    .min(1, { error: SECTIONS_ERROR }),
});

// Mode A.
const UniformBody = z
  .object({
    size: z
      .number({ error: "Provide an integer `size` of at least 1." })
      .int({ error: "Provide an integer `size` of at least 1." })
      .min(1, { error: "Provide an integer `size` of at least 1." }),
    overlap: z
      .number({ error: "Provide an integer `overlap` of at least 0." })
      .int({ error: "Provide an integer `overlap` of at least 0." })
      .min(0, { error: "Provide an integer `overlap` of at least 0." }),
  })
  .refine((b) => b.overlap < b.size, { error: "`overlap` must be smaller than `size`." });

// Shared response handling: 404 when the question isn't under the active config,
// 500 on an unexpected failure, else the experiment result.
async function respond(run: () => Promise<RechunkResult | null>): Promise<Response> {
  try {
    const result = await run();
    if (!result) {
      return Response.json(
        { error: "Question not found under the active config." },
        { status: 404 },
      );
    }
    return Response.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Re-chunk experiment failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const raw = await readJsonBody(request);
  if (raw.response) return raw.response;

  return withRequestConfig(request, async () => {
    // The presence of `sections` picks the mode, so a malformed Mode B payload
    // gets a sections error rather than complaints about a missing size/overlap.
    if (typeof raw.data === "object" && raw.data !== null && "sections" in raw.data) {
      const body = SectionsBody.safeParse(raw.data);
      if (!body.success) return invalidBody(body.error);
      return respond(() => runCustomChunkExperiment(id, body.data.sections));
    }

    const body = UniformBody.safeParse(raw.data);
    if (!body.success) return invalidBody(body.error);
    const { size, overlap } = body.data;
    return respond(() => runRechunkExperiment(id, size, overlap));
  });
}
