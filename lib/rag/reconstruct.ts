// ---------------------------------------------------------------------------
// Reconstruct source text from stored chunks (eval boundary editor only).
//
// The original document text isn't persisted — only chunk text is. But adjacent
// chunks overlap (chunkOverlap > 0), and that overlap reconstructs exactly
// (suffix of one chunk == prefix of the next), so we can stitch a contiguous run
// of chunks back into the surrounding text. Used by the "resize one custom
// chunk" experiment to show a chunk in the context of its frozen neighbors.
// ---------------------------------------------------------------------------

export type ChunkSpan = {
  position: number;
  charStart: number;
  charEnd: number; // [charStart, charEnd) of this chunk within the stitched text
};

// Longest k such that the last k chars of `a` equal the first k chars of `b` —
// the seam between two adjacent chunks. Scans from the longest possible match
// down so a short coincidental tail can't win over the real overlap.
function longestOverlap(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let k = max; k > 0; k--) {
    if (a.endsWith(b.slice(0, k))) return k;
  }
  return 0;
}

// Stitch chunks (any order; sorted here by position) into the contiguous source
// text, appending only each chunk's non-overlapping tail. Returns the text plus
// each chunk's [charStart, charEnd) span within it. With no detectable overlap
// (zero-overlap config, or a missing chunk creating a true gap) it falls back to
// plain concatenation, so spans stay well-defined.
export function stitchChunks(
  chunks: { position: number; text: string }[],
): { text: string; spans: ChunkSpan[] } {
  const ordered = [...chunks].sort((a, b) => a.position - b.position);
  const spans: ChunkSpan[] = [];
  let text = "";

  for (const chunk of ordered) {
    if (text.length === 0) {
      spans.push({ position: chunk.position, charStart: 0, charEnd: chunk.text.length });
      text = chunk.text;
      continue;
    }
    const overlap = longestOverlap(text, chunk.text);
    const charStart = text.length - overlap;
    text += chunk.text.slice(overlap);
    spans.push({ position: chunk.position, charStart, charEnd: text.length });
  }

  return { text, spans };
}
