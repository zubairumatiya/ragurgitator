// ---------------------------------------------------------------------------
// API route: POST /api/ingest
//
// Accepts either:
//   - multipart/form-data with one or more `file` fields
//     (.txt/.md/.pdf/.docx uploads), or
//   - multipart/form-data with `text` (a pasted-text string)
//
// On success it streams ingestion progress back as NDJSON (one IngestEvent per
// line) so the client can render a live progress bar; validation errors are
// returned as plain JSON before the stream starts. All RAG logic stays in
// lib/rag — this route just translates HTTP <-> input.
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { ingest, type IngestEvent } from "@/lib/rag/pipeline";
import type { LoadInput } from "@/lib/rag/loader";
import { ndjsonStream } from "@/lib/http/ndjson";

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const files = form
    .getAll("file")
    .filter((f): f is File => f instanceof File && f.size > 0);
  const text = form.get("text");

  let inputs: LoadInput[];
  if (files.length > 0) {
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
    inputs = files.map((file) => ({ kind: "file", file }));
  } else if (typeof text === "string" && text.trim()) {
    const fileName = typeof form.get("fileName") === "string"
      ? (form.get("fileName") as string)
      : undefined;
    inputs = [{ kind: "text", text, fileName }];
  } else {
    return Response.json(
      { error: "Provide either a `file` upload or a non-empty `text` field." },
      { status: 400 },
    );
  }

  // Stream progress as NDJSON so the client's progress bar advances in real time.
  return ndjsonStream<IngestEvent>(async (send) => {
    try {
      await ingest(inputs, send);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ingestion failed.";
      send({ type: "error", message });
    }
  });
}
