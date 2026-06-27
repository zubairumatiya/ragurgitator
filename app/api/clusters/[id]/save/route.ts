// ---------------------------------------------------------------------------
// API route: POST /api/clusters/[id]/save
//
// Keep a candidate run as a named preset (saved=true). Body: { name: string }.
// `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody, requiredTrimmedString } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { saveRun } from "@/lib/rag/clusterStore";

const Body = z.object({
  name: requiredTrimmedString("Provide a non-empty `name`."),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () => {
    try {
      const ok = await saveRun(id, body.data.name);
      if (!ok) return Response.json({ error: "Run not found." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save preset.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
