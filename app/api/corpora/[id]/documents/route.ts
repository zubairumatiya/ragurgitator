// ---------------------------------------------------------------------------
// API route: POST /api/corpora/[id]/documents — add documents to a corpus.
//
// Accepts either:
//   - multipart/form-data with `file` fields (.txt/.md/.pdf/.docx uploads) —
//     loaded + stored globally (deduped by content hash), then added, or
//   - JSON `{ documentIds: [...] }` — existing global documents to add.
//
// After membership is written, the docs are sync-embedded into every config
// auto-synced to this corpus, streamed as NDJSON IngestEvents (that's the part
// that costs embedding calls; zero synced configs = instant). Corpus-level, so
// no withRequestConfig. `params` is a Promise in this Next.js version.
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { ndjsonStream } from "@/lib/http/ndjson";
import { getCorpus } from "@/lib/rag/corpusStore";
import { loadDocument, type LoadInput } from "@/lib/rag/loader";
import { addDocsToCorpus, type IngestEvent } from "@/lib/rag/pipeline";
import type { SourceDocument } from "@/types/rag";

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const corpus = await getCorpus(id);
  if (!corpus) return Response.json({ error: "Corpus not found." }, { status: 404 });

  let loaded: SourceDocument[] = [];
  let documentIds: string[] = [];

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const files = form
      .getAll("file")
      .filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) {
      return Response.json({ error: "Provide at least one `file`." }, { status: 400 });
    }
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > config.maxUploadBytes) {
      return Response.json(
        {
          error:
            `Upload too large: ${formatMB(totalBytes)} across ${files.length} file(s). ` +
            `Max is ${formatMB(config.maxUploadBytes)}.`,
        },
        { status: 413 },
      );
    }
    // Load (parse/extract) before streaming starts, so a bad file is a clean
    // 400 instead of a mid-stream error.
    try {
      loaded = await Promise.all(
        files.map((file) => loadDocument({ kind: "file", file } satisfies LoadInput)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read upload.";
      return Response.json({ error: message }, { status: 400 });
    }
  } else {
    const raw = (await request.json().catch(() => null)) as { documentIds?: unknown } | null;
    if (
      !raw ||
      !Array.isArray(raw.documentIds) ||
      raw.documentIds.length === 0 ||
      !raw.documentIds.every((x): x is string => typeof x === "string")
    ) {
      return Response.json(
        { error: "Provide `file` uploads or a non-empty `documentIds` array." },
        { status: 400 },
      );
    }
    documentIds = raw.documentIds;
  }

  return ndjsonStream<IngestEvent>(async (send) => {
    try {
      await addDocsToCorpus(id, loaded, documentIds, send);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to add documents.";
      send({ type: "error", message });
    }
  });
}
