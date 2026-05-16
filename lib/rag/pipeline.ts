// ---------------------------------------------------------------------------
// ORCHESTRATION: ties the individual stages into two top-level flows.
//
// Ingestion flow (run when documents are added):
//   loader -> chunker -> embeddings -> vectorStore
//
// Query flow (run per user question):
//   retriever -> generator -> answer (+ sources)
//
// The API routes should call THIS module, not the individual stages, so the
// HTTP layer stays dumb and the RAG logic stays testable in isolation.
//
// TODO:
//   - export `ingest(input): Promise<{ chunksAdded: number }>`
//   - export `ask(question: string): Promise<{ answer: string; sources: ... }>`
// ---------------------------------------------------------------------------
