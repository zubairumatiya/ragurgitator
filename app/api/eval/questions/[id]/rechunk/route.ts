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
import {
  runCustomChunkExperiment,
  runRechunkExperiment,
  type RechunkResult,
} from "@/lib/rag/eval";

function readNumber(body: unknown, key: string): number | null {
  if (typeof body === "object" && body !== null && key in body) {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "number" ? value : null;
  }
  return null;
}

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // Mode B — explicit section text(s) replacing the chunk.
  if (typeof body === "object" && body !== null && "sections" in body) {
    const sections = (body as { sections: unknown }).sections;
    if (
      !Array.isArray(sections) ||
      sections.length === 0 ||
      !sections.every((s) => typeof s === "string" && s.trim().length > 0)
    ) {
      return Response.json(
        { error: "`sections` must be a non-empty array of non-empty strings." },
        { status: 400 },
      );
    }
    return respond(() => runCustomChunkExperiment(id, sections as string[]));
  }

  // Mode A — uniform size/overlap.
  const size = readNumber(body, "size");
  const overlap = readNumber(body, "overlap");

  if (size === null || !Number.isInteger(size) || size < 1) {
    return Response.json(
      { error: "Provide an integer `size` of at least 1." },
      { status: 400 },
    );
  }
  if (overlap === null || !Number.isInteger(overlap) || overlap < 0) {
    return Response.json(
      { error: "Provide an integer `overlap` of at least 0." },
      { status: 400 },
    );
  }
  if (overlap >= size) {
    return Response.json(
      { error: "`overlap` must be smaller than `size`." },
      { status: 400 },
    );
  }

  return respond(() => runRechunkExperiment(id, size, overlap));
}
