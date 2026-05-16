// ---------------------------------------------------------------------------
// API route: POST /api/chat
//
// Purpose: receive a user question, run the query flow, return the answer.
//
// Responsibility split:
//   - parse/validate the request body (the question, maybe chat history)
//   - delegate to pipeline.ask()
//   - return { answer, sources } as JSON  (consider streaming later)
//
// Streaming the answer back token-by-token is a great learning extension —
// check the current Next.js streaming-response API in
// node_modules/next/dist/docs/ before attempting it (AGENTS.md).
//
// TODO: implement and export the POST handler.
// ---------------------------------------------------------------------------
