// ---------------------------------------------------------------------------
// STEP 2 of ingestion: CHUNK
//
// Responsibility: split a SourceDocument's text into smaller overlapping
// `Chunk`s. Embedding models and LLM context windows are finite, so you
// retrieve at the chunk level, not the whole-document level.
//
// Key ideas to experiment with:
//   - fixed-size chunks (CHUNK_SIZE from config) with CHUNK_OVERLAP
//   - splitting on natural boundaries (paragraphs / sentences) before slicing
//   - carrying document metadata down onto every chunk
//
// TODO: export something like `chunkDocument(doc): Chunk[]`
// ---------------------------------------------------------------------------
