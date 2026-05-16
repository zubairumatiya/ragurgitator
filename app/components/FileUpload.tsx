// ---------------------------------------------------------------------------
// UI: upload / paste documents to ingest (Client Component — "use client").
//
// Responsibility:
//   - let the user pick a file or paste text
//   - POST it to /api/ingest
//   - show progress / result (e.g. "added 42 chunks")
//
// This is how you get content INTO the vector store before you can chat
// against it. Build this early so you have data to retrieve.
//
// TODO: build the form + submit handler.
// ---------------------------------------------------------------------------
