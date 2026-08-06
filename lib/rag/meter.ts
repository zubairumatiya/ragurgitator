// ---------------------------------------------------------------------------
// METERING — the one wrapper every Anthropic call goes through so gross LLM
// spend lands in spend_totals (docs/savings-accounting-plan.md §3, L2). It calls
// the SDK exactly as before, reads the real `usage` the response already carries
// (input/output tokens — previously discarded at every call site), records the
// cost against a Surface, and returns the untouched response so callers change
// only their import + the function name.
//
// Recording is fire-and-forget and best-effort (savingsStore swallows a missing
// table / any telemetry error), so metering never adds latency or a failure mode
// to an answer. Non-streaming only — every metered site here is non-streaming.
// ---------------------------------------------------------------------------
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicFor } from "@/lib/llm/client";
import { activeUserId } from "@/lib/auth/userScope";
import { costLlm, type Surface } from "@/lib/rag/pricing";
import { recordSpend } from "@/lib/rag/savingsStore";

export async function meteredMessage(
  surface: Surface,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  // The user's own key, resolved per call (cached 60s in lib/llm/client.ts).
  // Every generation site in the app funnels through here, so this one line is
  // what makes "whose key paid for this answer" have an answer at all.
  const client = await anthropicFor(activeUserId());
  const response = await client.messages.create(params);
  const u = response.usage;
  if (u) {
    const inTok = u.input_tokens ?? 0;
    const outTok = u.output_tokens ?? 0;
    void recordSpend(surface, costLlm(params.model, inTok, outTok), inTok + outTok);
  }
  return response;
}
