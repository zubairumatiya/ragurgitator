// ---------------------------------------------------------------------------
// API route: POST /api/configs/[id]/populate
//
// Spawn step for a config created over an EXISTING corpus: re-embed the corpus's
// stored documents under THIS config's settings (no re-upload — see
// pipeline.embedExistingCorpus). Streams the same IngestEvents as /api/ingest so
// the creation dialog can show a progress bar.
//
// Scoped to the config named in the path (not the active tab), so it resolves +
// enters that config's scope explicitly rather than via withRequestConfig.
// `params` is a Promise in this Next.js version. NDJSON producer enters the scope
// itself, so the deferred stream callback still sees the right config.
// ---------------------------------------------------------------------------
import { ndjsonStream } from "@/lib/http/ndjson";
import { resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { embedExistingCorpus, type IngestEvent } from "@/lib/rag/pipeline";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cfg = await resolveConfig(id);
  if (!cfg) return Response.json({ error: "Config not found." }, { status: 404 });

  return ndjsonStream<IngestEvent>(async (send) => {
    try {
      await withConfig(cfg, () => embedExistingCorpus(send));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Spawn embedding failed.";
      send({ type: "error", message });
    }
  });
}
