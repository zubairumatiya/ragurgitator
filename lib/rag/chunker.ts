// ---------------------------------------------------------------------------
// STEP 2 of ingestion: CHUNK
//
// Splits a SourceDocument into smaller, overlapping `Chunk`s. Retrieval happens
// at the chunk level, so chunk size is a retrieval-quality knob (see config).
//
// Sizing is measured in tokens of the embedding model's own tokenizer
// (voyageai/<model> on the HF Hub), so a chunk's length matches what Voyage
// actually sees when it embeds that chunk.
// ---------------------------------------------------------------------------
import { AutoTokenizer } from "@huggingface/transformers";

import { config } from "@/lib/config";
import type { Chunk, SourceDocument } from "@/types/rag";

// Loaded once on first use, then reused. from_pretrained fetches the tokenizer
// from the HF Hub and caches it on disk.
let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | null =
  null;

function getTokenizer() {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(
    `voyageai/${config.embeddingModel}`,
  );
  return tokenizerPromise;
}

export async function chunkDocument(doc: SourceDocument): Promise<Chunk[]> {
  const t0 = performance.now();
  const tokenizer = await getTokenizer();
  // Special tokens belong at the document boundary, not at every chunk seam.
  const tokenIds = tokenizer.encode(doc.text, { add_special_tokens: false });

  const { chunkSize, chunkOverlap } = config;
  const stride = chunkSize - chunkOverlap;

  const chunks: Chunk[] = [];
  for (let start = 0; start < tokenIds.length; start += stride) {
    const text = tokenizer
      .decode(tokenIds.slice(start, start + chunkSize), {
        skip_special_tokens: true,
      })
      .trim();
    if (text) {
      chunks.push({
        id: crypto.randomUUID(),
        documentId: doc.id,
        text,
        position: chunks.length,
      });
    }
    // The window already reaches the end — a further stride would only re-emit
    // tokens that are entirely inside this chunk's overlap region.
    if (start + chunkSize >= tokenIds.length) break;
  }

  console.log(
    `[rag:chunker] doc ${doc.id.slice(0, 8)} (${doc.metadata.fileName}): ` +
      `${tokenIds.length} tokens -> ${chunks.length} chunks (size=${chunkSize}, overlap=${chunkOverlap}) in ${Math.round(performance.now() - t0)}ms`,
  );
  return chunks;
}
