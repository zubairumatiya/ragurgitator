// ---------------------------------------------------------------------------
// API route: GET/DELETE /api/clusters/[id]
//
// GET returns one run's full detail (per-bucket cohesion/size + a nearest-to-
// centroid representative chunk). DELETE removes a run/preset (its clusters and
// assignments cascade). `params` is a Promise in this Next.js version — await it.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { deleteRun, getRun } from "@/lib/rag/clusterStore";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRequestConfig(request, async () => {
    try {
      const run = await getRun(id);
      if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
      return Response.json(run);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load run.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withRequestConfig(request, async () => {
    try {
      const ok = await deleteRun(id);
      if (!ok) return Response.json({ error: "Run not found." }, { status: 404 });
      return Response.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete run.";
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
