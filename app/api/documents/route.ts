// ---------------------------------------------------------------------------
// API route: GET /api/documents
//
// Returns the list of documents currently held in the vector store, so the UI
// can show what's been ingested so far.
// ---------------------------------------------------------------------------
import { listDocuments } from "@/lib/rag/vectorStore";

export async function GET() {
  const documents = await listDocuments();
  return Response.json({ documents });
}
