// ---------------------------------------------------------------------------
// API route: POST /api/ingest
//
// Purpose: receive document(s) from the client (uploaded file or pasted text)
// and run the ingestion flow.
//
// Responsibility split:
//   - parse/validate the incoming request here
//   - delegate the actual work to pipeline.ingest()
//   - return a small JSON summary (e.g. how many chunks were added)
//
// Next.js 16 App Router route handlers live in this file as named exports
// (export async function POST(req: Request) { ... }). Before implementing,
// skim node_modules/next/dist/docs/ for the current route-handler + request
// parsing API (AGENTS.md warns this version differs from older Next.js).
//
// TODO: implement and export the POST handler.
// ---------------------------------------------------------------------------
