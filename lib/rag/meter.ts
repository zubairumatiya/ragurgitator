// METERING + PROVIDER DISPATCH — the one wrapper every generation call goes
// through, so gross LLM spend lands in spend_totals and so "which provider serves
// this model" is decided in exactly one place.
//
// It reads the real `usage` the response already carries, records the cost against
// a Surface, and returns the response so callers change only their import + the
// function name. Recording goes through detached() and is best-effort, so metering
// never adds latency or a failure mode to an answer. Non-streaming only.
//
// THE SIGNATURE IS ANTHROPIC-SHAPED ON PURPOSE. All six generation callers build
// Anthropic `MessageCreateParams` and read `response.content[0].text`, and three of
// them share those param builders verbatim with the BATCH path. So Anthropic's
// request and response shape stays the in-app lingua franca and the OpenAI path
// translates in and out. A neutral third shape would have meant rewriting six
// callers, three batch jobs, and every `content[0].text` read to buy symmetry
// nothing in the app needs.
//
// The metering itself needed no change for the second provider: costLlm() routes by
// model id, so once OpenAI ids are in LLM_PRICES the ledger works as-is.
//
// The Anthropic ⇄ Chat-Completions translation lives in lib/llm/openaiChat.ts, not
// here: the batch adapter needs the same pair and has no business importing the
// spend ledger to get them.
//
// TWO LEDGERS, ONE CALL, AND THEY ARE NOT REDUNDANT. recordSpend answers "what
// does this config cost to run" and only ever sees successes. trackKeyUsage (0072)
// answers "what did MY KEY do" and must see the rejections too — a burst of 401s
// spends nothing and is the most interesting thing that can happen to a key.
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicFor, openaiFor } from "@/lib/llm/client";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { toAnthropicMessage, toChatParams } from "@/lib/llm/openaiChat";
import { trackKeyUsage, type KeyUsageAmounts } from "@/lib/auth/keyUsageStore";
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
      ? await anthropicMessage(surface, params)
      : await openaiMessage(surface, params);

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

// --- Anthropic: the native path ------------------------------------------------

async function anthropicMessage(
  surface: Surface,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  // The user's own key, resolved per call (cached 60s in lib/llm/client.ts).
  // Every generation site in the app funnels through here, so this one line is
  // what makes "whose key paid for this answer" have an answer at all.
  //
  // Resolving it stays OUTSIDE the tracked span: a missing key means no call was
  // made, and a ledger row for it would invent a provider interaction that never
  // happened. It is also what populates the cache keyLastFourFor reads.
  const client = await anthropicFor(activeUserId());
  return trackKeyUsage(
    { provider: "anthropic", model: params.model, surface, kind: "message" },
    () => client.messages.create(params),
    (message) => llmAmounts(params.model, message),
  );
}

// --- OpenAI: translate in, call Chat Completions, translate out ---------------
//
// The translation is lib/llm/openaiChat.ts — which disagreements it normalises,
// and why it throws rather than dropping anything it cannot carry, are documented
// there. All that is left here is the call itself.

async function openaiMessage(
  surface: Surface,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  const client = await openaiFor(activeUserId());
  // The translation is inside the span so both providers can share one usage
  // reader. That is safe because toAnthropicMessage is total — it warns and zeroes
  // on missing usage rather than throwing — so nothing but a real provider failure
  // can land in the catch and be recorded as one.
  return trackKeyUsage(
    { provider: "openai", model: params.model, surface, kind: "message" },
    async () => toAnthropicMessage(await client.chat.completions.create(toChatParams(params))),
    (message) => llmAmounts(params.model, message),
  );
}

// Both paths hand back an Anthropic-shaped message, so the ledger reads its usage
// the same way and prices it through the same costLlm the spend totals use.
function llmAmounts(
  model: string,
  message: Anthropic.Messages.Message,
): KeyUsageAmounts {
  const inTok = message.usage?.input_tokens ?? 0;
  const outTok = message.usage?.output_tokens ?? 0;
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: costLlm(model, inTok, outTok),
  };
}
