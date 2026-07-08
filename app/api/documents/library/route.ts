// ---------------------------------------------------------------------------
// API route: GET /api/documents/library
//
// The user's LIBRARY for the active config: previously-uploaded documents
// (with stored raw text) that this config hasn't embedded yet. Backs the
// workbench's "User library" ingest mode — re-use an upload, no re-upload.
// ---------------------------------------------------------------------------
import { withRequestConfig } from "@/lib/http/configScope";
import { listLibraryDocuments } from "@/lib/rag/vectorStore";

export async function GET(request: Request) {
  return withRequestConfig(request, async () => {
    const documents = await listLibraryDocuments();
    return Response.json({ documents });
  });
}
