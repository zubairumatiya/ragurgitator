// METERING + PROVIDER DISPATCH — the one wrapper every generation call goes
// through, so gross LLM spend lands in spend_totals (docs/savings-accounting-plan.md
// §3, L2) and so "which provider serves this model" is decided in exactly one
// place (docs/user-accounts-plan.md §9.1).
//
// It reads the real `usage` the response already carries (input/output tokens —
// previously discarded at every call site), records the cost against a Surface,
// and returns the response so callers change only their import + the function
// name. Recording goes through detached() (lib/detached.ts) and is best-effort
// (savingsStore swallows a missing table / any telemetry error), so metering
// never adds latency or a failure mode to an answer. Non-streaming only — every
// metered site is.
//
// THE SIGNATURE IS ANTHROPIC-SHAPED ON PURPOSE. All six generation callers
// (generator, eval, ranking, clusterLabeler, semanticCacheCalibration,
// semanticCachePairs) build Anthropic `MessageCreateParams` and read
// `response.content[0].text`, and three of them (eval, clusterLabeler,
// semanticCachePairs) share those param builders verbatim with the BATCH path.
// So Anthropic's request and response shape stays the in-app lingua franca and
// the OpenAI path translates in and out. The alternative — a neutral third shape
// — would have meant rewriting six callers, three batch jobs, and every
// `content[0].text` read to buy symmetry nothing in the app needs.
//
// The batch path holds to the same convention rather than being an exception to
// it: lib/batch/providers.ts submits these very params as JSONL and translates
// them with the SAME functions this file uses, so a batched request and a
// synchronous one are identical by construction.
//
// The metering itself needed no change for the second provider: costLlm() routes
// by model id, so once OpenAI ids are in LLM_PRICES the ledger works as-is.
//
// The Anthropic ⇄ Chat-Completions translation itself lives in lib/llm/openaiChat.ts,
// not here: the batch adapter needs the same pair (see its header), and it has no
// business importing the spend ledger to get them.
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicFor, openaiFor } from "@/lib/llm/client";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { toAnthropicMessage, toChatParams } from "@/lib/llm/openaiChat";
import { activeUserId } from "@/lib/auth/userScope";
import { detached } from "@/lib/detached";
import { costLlm, type Surface } from "@/lib/rag/pricing";
import { recordSpend } from "@/lib/rag/savingsStore";

export async function meteredMessage(
  surface: Surface,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  // Provider comes from the model id, never from a separate setting — see
  // llmModels.llmProviderFor. Unrecognised prefix throws here rather than
  // defaulting, because the default would be someone else's bill.
  const response =
    llmProviderOf(params.model) === "anthropic"
      ? await anthropicMessage(params)
      : await openaiMessage(params);

  const u = response.usage;
  if (u) {
    const inTok = u.input_tokens ?? 0;
    const outTok = u.output_tokens ?? 0;
    await detached(() =>
      recordSpend(surface, costLlm(params.model, inTok, outTok), inTok + outTok),
    );
  }
  return response;
}

// --- Anthropic: the native path, unchanged -----------------------------------

async function anthropicMessage(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  // The user's own key, resolved per call (cached 60s in lib/llm/client.ts).
  // Every generation site in the app funnels through here, so this one line is
  // what makes "whose key paid for this answer" have an answer at all.
  const client = await anthropicFor(activeUserId());
  return client.messages.create(params);
}

// --- OpenAI: translate in, call Chat Completions, translate out ---------------
//
// The translation is lib/llm/openaiChat.ts — which disagreements it normalises,
// and why it throws rather than dropping anything it cannot carry, are documented
// there. All that is left here is the call itself.

async function openaiMessage(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  const client = await openaiFor(activeUserId());
  const completion = await client.chat.completions.create(toChatParams(params));
  return toAnthropicMessage(completion);
}
