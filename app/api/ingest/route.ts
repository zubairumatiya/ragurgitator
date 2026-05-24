// ---------------------------------------------------------------------------
// API route: POST /api/ingest
//
// Accepts either:
//   - multipart/form-data with `file` (a .txt/.md/.pdf/.docx upload), or
//   - multipart/form-data with `text` (a pasted-text string)
//
// Delegates the actual work to pipeline.ingest() and returns a small summary.
// All RAG logic stays in lib/rag — this route just translates HTTP <-> input.
// ---------------------------------------------------------------------------
import { ingest } from "@/lib/rag/pipeline";
import type { LoadInput } from "@/lib/rag/loader";

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

  const file = form.get("file");
  const text = form.get("text");

  let input: LoadInput;
  if (file instanceof File && file.size > 0) {
    input = { kind: "file", file };
  } else if (typeof text === "string" && text.trim()) {
    const fileName = typeof form.get("fileName") === "string"
      ? (form.get("fileName") as string)
      : undefined;
    input = { kind: "text", text, fileName };
  } else {
    return Response.json(
      { error: "Provide either a `file` upload or a non-empty `text` field." },
      { status: 400 },
    );
  }

  try {
    const result = await ingest(input);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
