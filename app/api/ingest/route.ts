// ---------------------------------------------------------------------------
// API route: POST /api/ingest
//
// Accepts either:
//   - multipart/form-data with one or more `file` fields
//     (.txt/.md/.pdf/.docx uploads), or
//   - multipart/form-data with `text` (a pasted-text string)
//
// Delegates the actual work to pipeline.ingest() and returns a per-source
// summary ({ results: [{ fileName, chunksAdded } | { fileName, error }] }).
// All RAG logic stays in lib/rag — this route just translates HTTP <-> input.
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { ingest } from "@/lib/rag/pipeline";
import type { LoadInput } from "@/lib/rag/loader";

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

  try {
    const result = await ingest(inputs);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
