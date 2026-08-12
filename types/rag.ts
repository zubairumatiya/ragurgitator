// Shared types for the RAG pipeline — the contract every module agrees on.
export type SourceDocument = {
  id: string;
  text: string;
  metadata: { fileName: string };
};

export type Chunk = {
  id: string;
  documentId: string;
  text: string;
  position: number;
};

export type EmbeddedChunk = { embedding: number[]; chunk: Chunk };

export type RetrievedChunk = { score: number; chunk: EmbeddedChunk };

export type ChatMessage = { role: "user" | "assistant"; content: string };
