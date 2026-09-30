// STEP 1 of ingestion: LOAD
//
// Takes a raw source (pasted text or an uploaded .txt/.md/.pdf/.docx file) and
// turns it into clean `SourceDocument` objects with text extracted and basic
// metadata attached. Parsing concerns stay isolated here — no chunking,
// embedding, or storage.
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

import { log } from "@/lib/log";
import type { SourceDocument } from "@/types/rag";

export type LoadInput =
  | { kind: "text"; text: string; fileName?: string }
  | { kind: "file"; file: File };

// A human-readable label for an input, available even before (or instead of)
// a successful load — so the pipeline can report which source failed.
export function labelFor(input: LoadInput): string {
  return input.kind === "text"
    ? input.fileName?.trim() || "pasted-text"
    : input.file.name;
}

// Loads exactly one source. Throws on failure; the caller isolates errors
// per-source so one bad file doesn't sink a whole batch.
export async function loadDocument(input: LoadInput): Promise<SourceDocument> {
  const t0 = performance.now();
  if (input.kind === "text") {
    const text = input.text.trim();
    if (!text) throw new Error("Cannot load empty text.");
    const name = labelFor(input);
    log.debug("loaded pasted input", { component: "rag:loader", fileName: name, chars: text.length, ms: ms(t0) });
    return toDocument(text, name);
  }

  const { file } = input;
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  log.debug("loading file", { component: "rag:loader", fileName: file.name, bytes: file.size, ext });
  const text = (await extractFileText(file, ext)).trim();

  if (!text) {
    throw new Error(`No text could be extracted from "${file.name}".`);
  }
  log.debug("extracted file", { component: "rag:loader", fileName: file.name, chars: text.length, ms: ms(t0) });
  return toDocument(text, file.name);
}

function ms(t0: number): number {
  return Math.round(performance.now() - t0);
}

async function extractFileText(file: File, ext: string): Promise<string> {
  switch (ext) {
    case ".txt":
    case ".md":
      return file.text();
    case ".pdf":
      return extractPdfText(file);
    case ".docx":
      return extractDocxText(file);
    default:
      throw new Error(
        `Unsupported file type "${ext || file.name}". Supported: .txt, .md, .pdf, .docx`,
      );
  }
}

async function extractPdfText(file: File): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
  const { text } = await extractText(pdf, { mergePages: true });
  // A scanned/image-only PDF has no text layer, so extraction yields nothing.
  if (!text.trim()) {
    throw new Error(
      `"${file.name}" looks like a scanned or image-only PDF — extract its text with OCR first.`,
    );
  }
  return text;
}

async function extractDocxText(file: File): Promise<string> {
  const { value } = await mammoth.extractRawText({
    arrayBuffer: await file.arrayBuffer(),
  });
  return value;
}

function toDocument(text: string, fileName: string): SourceDocument {
  return {
    id: crypto.randomUUID(),
    text,
    metadata: { fileName },
  };
}
