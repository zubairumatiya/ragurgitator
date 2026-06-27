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

import { activeConfig } from "@/lib/rag/activeConfig";
import type { Chunk, SourceDocument } from "@/types/rag";

// Cached per model on first use, then reused: different configs can use different
// embedding models, so we can't share one tokenizer. from_pretrained fetches the
// tokenizer from the HF Hub and caches it on disk.
const tokenizerCache = new Map<
  string,
  ReturnType<typeof AutoTokenizer.from_pretrained>
>();

function getTokenizer(model: string) {
  let promise = tokenizerCache.get(model);
  if (!promise) {
    promise = AutoTokenizer.from_pretrained(`voyageai/${model}`);
    tokenizerCache.set(model, promise);
  }
  return promise;
}

type Tokenizer = Awaited<ReturnType<typeof getTokenizer>>;

// The windowing core, shared by document chunking and the eval re-chunk sandbox
// so both produce identical pieces. Slides a `size`-token window by `size -
// overlap` over pre-encoded token ids, decoding each window back to trimmed
// text. Empty windows are dropped.
function decodeWindows(
  tokenizer: Tokenizer,
  tokenIds: number[],
  size: number,
  overlap: number,
): string[] {
  const stride = size - overlap;
  if (stride <= 0) {
    throw new Error(
      `chunk overlap (${overlap}) must be smaller than size (${size}).`,
    );
  }

  const pieces: string[] = [];
  for (let start = 0; start < tokenIds.length; start += stride) {
    const text = tokenizer
      .decode(tokenIds.slice(start, start + size), { skip_special_tokens: true })
      .trim();
    if (text) pieces.push(text);
    // The window already reaches the end — a further stride would only re-emit
    // tokens that are entirely inside this window's overlap region.
    if (start + size >= tokenIds.length) break;
  }
  return pieces;
}

// Split arbitrary text into overlapping token-windowed pieces at a chosen size
// and overlap. Used by the eval "re-chunk this chunk" experiment to re-split a
// single chunk's text without touching the corpus. Same tokenizer + stride as
// chunkDocument, so a piece's length matches what Voyage embeds.
export async function splitText(
  text: string,
  size: number,
  overlap: number,
): Promise<string[]> {
  const tokenizer = await getTokenizer(activeConfig().embeddingModel);
  // Special tokens belong at the document boundary, not at every chunk seam.
  const tokenIds = tokenizer.encode(text, { add_special_tokens: false });
  return decodeWindows(tokenizer, tokenIds, size, overlap);
}

// Encode `text` and return, for the eval boundary editor, how many tokens it has
// and the char offset at which each token boundary falls: offsets[t] is the char
// index where token t begins, and offsets[tokenCount] === text.length. This lets
// the UI map a token-based border to a character slice of the same text.
//
// Fast path is O(n): sum each token's isolated decode length. That matches the
// exact cumulative-prefix decode for normal text (verified), but isolated decode
// can drift on unusual input (byte-fallback tokens, odd Unicode), so we guard on
// the final offset and recompute exactly when it doesn't land on text.length.
export async function tokenizeWithOffsets(
  text: string,
): Promise<{ tokenCount: number; offsets: number[] }> {
  const tokenizer = await getTokenizer(activeConfig().embeddingModel);
  const ids = tokenizer.encode(text, { add_special_tokens: false });

  const offsets = [0];
  let acc = 0;
  for (const id of ids) {
    acc += tokenizer.decode([id], { skip_special_tokens: true }).length;
    offsets.push(acc);
  }

  if (offsets[offsets.length - 1] !== text.length) {
    // Exact fallback: char length of each growing prefix. O(n^2) but only hit on
    // text whose per-token decodes don't sum to the whole.
    const exact = [0];
    for (let i = 1; i <= ids.length; i++) {
      exact.push(
        tokenizer.decode(ids.slice(0, i), { skip_special_tokens: true }).length,
      );
    }
    exact[exact.length - 1] = text.length; // clamp any residual drift
    return { tokenCount: ids.length, offsets: exact };
  }

  return { tokenCount: ids.length, offsets };
}

export async function chunkDocument(doc: SourceDocument): Promise<Chunk[]> {
  const t0 = performance.now();
  const tokenizer = await getTokenizer(activeConfig().embeddingModel);
  // Special tokens belong at the document boundary, not at every chunk seam.
  const tokenIds = tokenizer.encode(doc.text, { add_special_tokens: false });

  const { chunkSize, chunkOverlap } = activeConfig();
  const chunks: Chunk[] = decodeWindows(
    tokenizer,
    tokenIds,
    chunkSize,
    chunkOverlap,
  ).map((text, position) => ({
    id: crypto.randomUUID(),
    documentId: doc.id,
    text,
    position,
  }));

  console.log(
    `[rag:chunker] doc ${doc.id.slice(0, 8)} (${doc.metadata.fileName}): ` +
      `${tokenIds.length} tokens -> ${chunks.length} chunks (size=${chunkSize}, overlap=${chunkOverlap}) in ${Math.round(performance.now() - t0)}ms`,
  );
  return chunks;
}
