// ---------------------------------------------------------------------------
// STEP 3 of ingestion (and also used at query time): EMBED
//
// Responsibility: turn text into a vector (number[]) using an embedding model.
// The SAME model must be used for documents at ingest time and for the user's
// question at query time, or similarity search is meaningless.
//
// Things to handle here:
//   - calling the embedding API/provider (read model + key from config/env)
//   - batching many chunks in one call for efficiency
//   - a single-string helper for embedding a query
//
// TODO: export `embedTexts(texts: string[]): Promise<number[][]>`
//       and    `embedQuery(text: string): Promise<number[]>`
// ---------------------------------------------------------------------------
