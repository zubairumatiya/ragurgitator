// ---------------------------------------------------------------------------
// The RE-INGEST SKIP lever (docs/savings-accounting-plan.md §2, lever #9 —
// "skip re-embed of ingested docs"). Sibling of lib/batch/savings.ts: one
// lever, one place, so every skip site prices identically.
//
// Counterfactual: the naive app re-chunks and re-embeds a document every time
// it's handed over. We embed it once per config and skip thereafter — re-upload
// the same file, sync a corpus that already covers it, or re-run a batch job,
// and the whole document's embed is avoided. That's what this banks.
//
// Banked on EVERY skip, not once per document, matching how embedCache credits
// a repeat hit: each skip is a call the naive app would have made and we didn't.
// So the total answers "what has this app avoided spending to date", which is
// what the ledger is for — it is NOT a claim about a single ingest's cost.
//
// Best-effort, like every other telemetry path here: the whole body is guarded
// so a savings write can never fail an ingest, and callers `void` it.
// ---------------------------------------------------------------------------
import { activeConfig } from "@/lib/rag/activeConfig";
import { costEmbed, estimateTokensFromChars } from "@/lib/rag/pricing";
import { recordSaving } from "@/lib/rag/savingsStore";
import { embeddedRunSize } from "@/lib/rag/vectorStore";

// Price the embed avoided by skipping `documentId`, already embedded under the
// active config. One event per avoided CHUNK embed (embed_cache's convention:
// an event is one text that didn't have to be sent), so the two structural
// embed levers stay comparable on the itemized view.
export async function recordIngestSkip(documentId: string): Promise<void> {
  try {
    const run = await embeddedRunSize(documentId);
    if (!run) return; // no chunk rows to price — nothing provable was avoided
    const tokens = estimateTokensFromChars(run.chars);
    await recordSaving("ingest_skip", costEmbed(activeConfig().embeddingModel, tokens), tokens, {
      events: run.chunks,
    });
  } catch (err) {
    console.warn(`[rag:savings] ingest-skip record failed: ${(err as Error).message}`);
  }
}
