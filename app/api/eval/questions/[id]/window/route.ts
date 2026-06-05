// ---------------------------------------------------------------------------
// API route: GET /api/eval/questions/[id]/window?from=&to=
//
// Backs the "resize one custom chunk" editor: returns the labeled chunk plus its
// neighbors in [from, to], stitched into contiguous text with per-token char
// offsets and each chunk's token span (see lib/rag/eval.buildChunkWindow). Read-
// only; nothing is persisted. `params` is a Promise in this Next.js version.
// ---------------------------------------------------------------------------
import { buildChunkWindow } from "@/lib/rag/eval";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const from = Number(fromRaw);
  const to = Number(toRaw);

  if (
    fromRaw === null ||
    toRaw === null ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from
  ) {
    return Response.json(
      { error: "Provide integer `from` and `to` with 0 <= from <= to." },
      { status: 400 },
    );
  }

  try {
    const window = await buildChunkWindow(id, from, to);
    if (!window) {
      return Response.json(
        { error: "Question not found under the active config." },
        { status: 404 },
      );
    }
    return Response.json(window);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to build chunk window.";
    return Response.json({ error: message }, { status: 500 });
  }
}
