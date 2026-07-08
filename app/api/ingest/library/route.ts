// ---------------------------------------------------------------------------
// API route: POST /api/ingest/library
//
// Ingest previously-uploaded documents into the ACTIVE config by id — the
// "User library" mode on the workbench (no re-upload; raw text was stored at
// first ingest, migration 0010). Body: { documentIds: [...] }. Streams the same
// NDJSON IngestEvents as /api/ingest so the upload panel reuses its progress UI.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import { embedDocumentsById, type IngestEvent } from "@/lib/rag/pipeline";

const Body = z.object({
  documentIds: z
    .array(z.uuid({ error: "`documentIds` must be an array of document ids." }))
    .min(1, { error: "Pick at least one document." }),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () =>
    ndjsonStream<IngestEvent>(async (send) => {
      try {
        await embedDocumentsById(body.data.documentIds, send);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Library ingest failed.";
        send({ type: "error", message });
      }
    }),
  );
}
