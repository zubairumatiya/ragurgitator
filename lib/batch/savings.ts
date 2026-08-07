// ---------------------------------------------------------------------------
// BATCH SAVINGS — bank the discount an applied batch realized vs. the
// synchronous API (docs/savings-accounting-plan.md §2 #4). Called from each
// handler's apply(), which runs inside the job's config scope — so recordSaving
// picks up the right config with no explicit id.
//
// Each leg's saving is priced where its token counts actually live:
//   • LLM    — the result bodies carry real per-request `usage`, so sum it.
//   • Voyage — result rows carry only embedding vectors (no usage), so price
//              the −33% from the embedded texts (char/4), like embed_cache.
// Both defer through detached(); savingsStore swallows a missing table / any
// error. /api/batch/poll is an ordinary request, so these ARE queued — and the
// config each one captures is the JOB's, since the orchestrator enters a
// different config scope per job (lib/batch/orchestrator.ts). A request-level
// config snapshot would file every job's saving against one config.
// ---------------------------------------------------------------------------
import { detached } from "@/lib/detached";
import { BATCH_DISCOUNT, costEmbed, costLlm, estimateTokensAll } from "@/lib/rag/pricing";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { recordSaving } from "@/lib/rag/savingsStore";
import type { BatchResultRow } from "@/lib/batch/types";

// LLM leg (question generation, cluster labeling, cache pairs) — either provider.
// Sums the real usage across every succeeded result: the batch paid for all of
// them, so all of them saved vs. standard price.
//
// MODEL AND RATE BOTH COME FROM THE RESULT BODY, not the caller. The OpenAI
// adapter translates its ChatCompletions back into the same Anthropic Message
// shape (lib/llm/openaiChat.ts), so `usage` and `model` are read identically on
// both legs, and the discount is looked up from the model's own provider rather
// than assumed. Today both are 0.5, which is exactly why hardcoding one would go
// unnoticed until a provider changed its batch price.
export async function bankLlmBatchSaving(results: BatchResultRow[]): Promise<void> {
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
  // A provider echoes back its own resolved id, which llmProviderOf answers for
  // by prefix even when it is a dated variant the registry doesn't list. An
  // unrecognised one would throw here, inside a fire-and-forget accounting call
  // that must never fail an applied batch — so it degrades to banking nothing.
  let discount: number;
  try {
    discount = BATCH_DISCOUNT[llmProviderOf(model)];
  } catch {
    return;
  }
  const saved = costLlm(model, inTok, outTok) * discount;
  await detached(() => recordSaving("batch", saved, inTok + outTok));
}

// Voyage-leg (ingest_embedding). `texts` are the chunk texts actually embedded
// and stored; price the −33% off their estimated tokens.
export async function bankVoyageBatchSaving(texts: string[], model: string): Promise<void> {
  if (texts.length === 0) return;
  const tokens = estimateTokensAll(texts);
  const saved = costEmbed(model, tokens) * BATCH_DISCOUNT.voyage;
  await detached(() => recordSaving("batch", saved, tokens));
}
