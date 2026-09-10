// THE RETRIEVAL RECORDER — docs/demo-retrieval-bank-plan.md §3.4.
//
// While the publish's walk drives a dev server through the demo's paths (§4),
// every retrieval scoreQuestions COMPUTES — never one it read from the bank —
// is appended here as one NDJSON line: the portable key it was computed under,
// the question's text hash, and the ranked list as text hashes. scripts/
// demo-snapshot's --walk then packs the file into demo_replay rows on the seed
// (lib/demo/replayCore.packRetrieval).
//
// ENV-GATED AND A PASSTHROUGH WHEN OFF, on lib/autotuneTiming's terms exactly:
// DEMO_RETRIEVAL_RECORD names the file, nothing sets it in production, and
// scripts/guards.ts sweep 10 holds the gate and the closed list of importers,
// so a publish-time instrument cannot quietly become a request-time feature.
//
// HASHES, NOT IDS. `RetrievedChunk.chunk.chunk.text` is present on both the
// fast path (vectorStore.query selects it) and the fused path
// (retrieveWithCutoffs resolves the winners' text), so the hash is computable
// in-process with no extra read — and a line that names only hashes can be
// recorded from a throwaway guest and banked for every later one. A retrieved
// chunk WITHOUT text is a line that would bank sha256("") as a chunk; it is
// dropped with one warning rather than written, because a bank that hits on a
// wrong list is the one failure this whole design exists to rule out.
import { appendFileSync } from "node:fs";

import type { RetrievedChunk } from "@/types/rag";
import { textHash, type RetrievalRecord } from "@/lib/demo/replayCore";
import type { ScreenCutoffs } from "@/lib/rag/retriever";

export const RETRIEVAL_RECORD_FILE = process.env.DEMO_RETRIEVAL_RECORD ?? "";
export const RETRIEVAL_RECORDING = RETRIEVAL_RECORD_FILE !== "";

let warnedTextless = false;

export function recordRetrieval(input: {
  key: string;
  question: string;
  depth: number;
  retrieved: RetrievedChunk[];
  cutoffs: ScreenCutoffs;
}): void {
  if (!RETRIEVAL_RECORDING) return;
  if (input.retrieved.some((r) => r.chunk.chunk.text === "")) {
    if (!warnedTextless) {
      warnedTextless = true;
      console.warn(
        "[rag:demo] retrieval recorder: a retrieved chunk carried no text; its line was not " +
          "recorded (a bank keyed on sha256('') would hit on the wrong list)",
      );
    }
    return;
  }
  const line: RetrievalRecord = {
    key: input.key,
    q: textHash(input.question),
    depth: input.depth,
    ids: input.retrieved.map((r) => textHash(r.chunk.chunk.text)),
    scores: input.retrieved.map((r) => r.score),
    cutoffs: input.cutoffs,
  };
  appendFileSync(RETRIEVAL_RECORD_FILE, JSON.stringify(line) + "\n");
}
