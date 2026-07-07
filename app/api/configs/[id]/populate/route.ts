// ---------------------------------------------------------------------------
// API route: POST /api/configs/[id]/populate
//
// Spawn step for a config created from existing corpora: embed their stored
// documents under THIS config's settings (no re-upload). Optional JSON body
// `{ corpusIds: [...] }` names the source selection (de-duped union — the
// multi-corpus create); with no body it falls back to the config's own corpus.
// Streams the same IngestEvents as /api/ingest so the creation dialog can show
// a progress bar.
//
// Scoped to the config named in the path (not the active tab), so it resolves +
// enters that config's scope explicitly rather than via withRequestConfig.
// `params` is a Promise in this Next.js version. NDJSON producer enters the scope
// itself, so the deferred stream callback still sees the right config.
// ---------------------------------------------------------------------------
import { ndjsonStream } from "@/lib/http/ndjson";
import { resolveConfig, withConfig } from "@/lib/rag/activeConfig";
import { embedCorpora, embedExistingCorpus, type IngestEvent } from "@/lib/rag/pipeline";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cfg = await resolveConfig(id);
  if (!cfg) return Response.json({ error: "Config not found." }, { status: 404 });

  // Body is optional (older callers send none). Non-JSON → treat as absent.
  const raw = (await request.json().catch(() => null)) as { corpusIds?: unknown } | null;
  const corpusIds =
    Array.isArray(raw?.corpusIds) && raw.corpusIds.every((x) => typeof x === "string")
      ? (raw.corpusIds as string[])
      : null;

  return ndjsonStream<IngestEvent>(async (send) => {
    try {
      await withConfig(cfg, () =>
        corpusIds && corpusIds.length > 0
          ? embedCorpora(corpusIds, send)
          : embedExistingCorpus(send),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Spawn embedding failed.";
      send({ type: "error", message });
    }
  });
}
