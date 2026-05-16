// ---------------------------------------------------------------------------
// Shared types for the RAG pipeline.
//
// Defining these first gives you a contract every module agrees on. Sketch of
// the core shapes you'll probably need:
//
//   - SourceDocument : a raw input (id, text/content, metadata like filename)
//   - Chunk          : a slice of a document (id, documentId, text, position)
//   - EmbeddedChunk  : a Chunk plus its embedding vector (number[])
//   - RetrievedChunk : an EmbeddedChunk plus a similarity score
//   - ChatMessage    : { role: "user" | "assistant", content: string }
//
// TODO: turn the comments above into real `export interface` / `export type`
//       declarations as you decide what each stage needs.
// ---------------------------------------------------------------------------
