// ---------------------------------------------------------------------------
// BATCH SAVINGS — bank the discount an applied batch realized vs. the
// synchronous API (docs/savings-accounting-plan.md §2 #4). Called from each
// handler's apply(), which runs inside the job's config scope — so recordSaving
// picks up the right config with no explicit id.
//
// Each provider's saving is priced where its token counts actually live:
//   • Anthropic — the result bodies carry real per-request `usage`, so sum it.
//   • Voyage    — result rows carry only embedding vectors (no usage), so price
//                 the −33% from the embedded texts (char/4), like embed_cache.
// Both are fire-and-forget; savingsStore swallows a missing table / any error.
// ---------------------------------------------------------------------------
import { BATCH_DISCOUNT, costEmbed, costLlm, estimateTokensAll } from "@/lib/rag/pricing";
import { recordSaving } from "@/lib/rag/savingsStore";
import type { BatchResultRow } from "@/lib/batch/types";

// Anthropic-leg (question generation, cluster labeling, …). Sums the real usage
// across every succeeded result — the batch paid for all of them, so all of them
// saved −50% vs. standard price. Model comes from the result body.
export function bankAnthropicBatchSaving(results: BatchResultRow[]): void {
  let inTok = 0;
  let outTok = 0;
  let model = "";
  for (const r of results) {
    const b = r.body as
      | { usage?: { input_tokens?: number; output_tokens?: number }; model?: string }
      | null;
    if (!b?.usage) continue;
    inTok += b.usage.input_tokens ?? 0;
    outTok += b.usage.output_tokens ?? 0;
    if (b.model) model = b.model;
  }
  if (!model || inTok + outTok === 0) return;
  const saved = costLlm(model, inTok, outTok) * BATCH_DISCOUNT.anthropic;
  void recordSaving("batch", saved, inTok + outTok);
}

// Voyage-leg (ingest_embedding). `texts` are the chunk texts actually embedded
// and stored; price the −33% off their estimated tokens.
export function bankVoyageBatchSaving(texts: string[], model: string): void {
  if (texts.length === 0) return;
  const tokens = estimateTokensAll(texts);
  const saved = costEmbed(model, tokens) * BATCH_DISCOUNT.voyage;
  void recordSaving("batch", saved, tokens);
}
