// ---------------------------------------------------------------------------
// METERING + PROVIDER DISPATCH — the one wrapper every generation call goes
// through, so gross LLM spend lands in spend_totals (docs/savings-accounting-plan.md
// §3, L2) and so "which provider serves this model" is decided in exactly one
// place (docs/user-accounts-plan.md §9.1).
//
// It reads the real `usage` the response already carries (input/output tokens —
// previously discarded at every call site), records the cost against a Surface,
// and returns the response so callers change only their import + the function
// name. Recording is fire-and-forget and best-effort (savingsStore swallows a
// missing table / any telemetry error), so metering never adds latency or a
// failure mode to an answer. Non-streaming only — every metered site is.
//
// THE SIGNATURE IS ANTHROPIC-SHAPED ON PURPOSE. All six generation callers
// (generator, eval, ranking, clusterLabeler, semanticCacheCalibration,
// semanticCachePairs) build Anthropic `MessageCreateParams` and read
// `response.content[0].text`, and two of them (eval, clusterLabeler) share those
// param builders verbatim with the BATCH path, which is Anthropic's Message
// Batches API and cannot be made provider-neutral. So Anthropic's request and
// response shape stays the in-app lingua franca and the OpenAI path translates in
// and out, below. The alternative — a neutral third shape — would have meant
// rewriting six callers, two batch jobs, and every `content[0].text` read to buy
// symmetry nothing in the app needs.
//
// The metering itself needed no change for the second provider: costLlm() routes
// by model id, so once OpenAI ids are in LLM_PRICES the ledger works as-is.
// ---------------------------------------------------------------------------
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import { anthropicFor, openaiFor } from "@/lib/llm/client";
import { llmProviderOf } from "@/lib/llm/llmModels";
import { activeUserId } from "@/lib/auth/userScope";
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
    void recordSpend(surface, costLlm(params.model, inTok, outTok), inTok + outTok);
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
// CHAT COMPLETIONS, NOT THE RESPONSES API. The GPT-5 family serves both, and
// Chat Completions is by far the smaller diff from the Anthropic shape above —
// same system-then-turns message list, same single text answer, same flat usage
// counters. The Responses API's item/output model would need a second translation
// layer to arrive at the same place.
//
// Four disagreements to normalise (§9.1):
//
//   system prompt   top-level `system`   → a leading {role:"system"} message
//   output cap      `max_tokens`         → `max_completion_tokens`
//   response body   `content[]` blocks   → `choices[0].message.content`
//   usage           input_/output_tokens → prompt_/completion_tokens
//
// Anything this translation CANNOT carry across throws rather than being dropped
// silently. A prompt that quietly lost its schema constraint or its tools would
// come back as unparseable prose from a model that looks like it just did a bad
// job, which is a much worse afternoon than a thrown error naming the field.

async function openaiMessage(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Messages.Message> {
  const client = await openaiFor(activeUserId());
  const completion = await client.chat.completions.create(toChatParams(params));
  return toAnthropicMessage(completion);
}

function toChatParams(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  if (params.tools?.length) {
    throw new Error("meteredMessage: tool use is not translated to OpenAI yet.");
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  // Anthropic's `system` is a top-level field and may be an array of text blocks
  // carrying `cache_control` (eval.ts marks its static prefix ephemeral). OpenAI
  // caches long prefixes automatically with no request-side control, so the
  // blocks flatten to one string and the cache_control markers are dropped —
  // they are a hint, not semantics, and losing them costs money, not correctness.
  const system = flattenText(params.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of params.messages) {
    messages.push({ role: message.role, content: flattenText(message.content) });
  }

  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: params.model,
    messages,
    // `max_tokens` still exists on the OpenAI SDK but is deprecated and rejected
    // by the GPT-5 family. `max_completion_tokens` is the current name and the
    // one that also counts reasoning tokens against the cap.
    max_completion_tokens: params.max_tokens,
  };

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.stop_sequences?.length) body.stop = params.stop_sequences;

  // `thinking: {type:"disabled"}` (eval.ts, for a pure formatting task) maps to
  // reasoning_effort "none". The `enabled` case deliberately maps to NOTHING:
  // Anthropic states a thinking budget in tokens and OpenAI takes a coarse
  // effort level, so any mapping between them would be an invented equivalence.
  // Omitting it leaves the model on its own default, which is the honest answer
  // to "think as much as you normally would".
  if (params.thinking?.type === "disabled") body.reasoning_effort = "none";

  // Structured outputs. Anthropic's output_config.format is a bare JSON schema;
  // OpenAI wants it named and flagged strict. `strict: true` is the point of
  // setting it at all — it is what makes the parse in the caller safe — and it
  // requires the schema to use the strict subset (every object closed with
  // additionalProperties:false, every property required), which the app's one
  // schema (eval.QUESTIONS_FORMAT) already does.
  const format = params.output_config?.format;
  if (format) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: format.schema, strict: true },
    };
  }

  return body;
}

// Anthropic content — a string, or blocks — as the plain string OpenAI wants.
// Non-text blocks (images, documents, tool results) throw: no caller sends one
// today, and silently dropping an image would produce an answer about a prompt
// the user did not write.
function flattenText(
  content: string | Array<Anthropic.Messages.TextBlockParam> | Anthropic.Messages.MessageParam["content"] | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type !== "text") {
        throw new Error(`meteredMessage: cannot send a "${block.type}" block to OpenAI.`);
      }
      return block.text;
    })
    .join("\n\n");
}

function toAnthropicMessage(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): Anthropic.Messages.Message {
  const choice = completion.choices[0];
  const text = choice?.message.content ?? null;

  // NULL CONTENT IS NOT AN EMPTY ANSWER. OpenAI returns `content: null` when the
  // turn produced no text — a refusal (the sibling `refusal` field is set), a
  // content filter, or a cap hit before the first token. Translating that to a
  // text block containing "" would hand generator.ts an empty but "successful"
  // answer to cache and show. An empty `content` array instead lands every
  // caller on the path it already has for a text-less response
  // ("LLM returned no text content", or a skipped chunk in eval.ts).
  const content: Anthropic.Messages.ContentBlock[] =
    text === null ? [] : [{ type: "text", text, citations: null }];

  const usage = completion.usage;
  if (!usage) {
    // Usage is optional on the OpenAI response type. Zeros keep the ledger
    // UNDER-counting rather than lying, the same rule pricing.ts applies to an
    // unknown model — but it is silent money, so say so once.
    warnMissingUsage(completion.model);
  }

  return {
    id: completion.id,
    container: null,
    content,
    model: completion.model,
    role: "assistant",
    stop_details: null,
    stop_reason: stopReasonOf(choice),
    stop_sequence: null,
    type: "message",
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      // Cache counters stay null rather than being filled from
      // prompt_tokens_details.cached_tokens: Anthropic's input_tokens EXCLUDES
      // cache reads while OpenAI's prompt_tokens INCLUDES them, so copying the
      // number across would double-count for anything that sums the two fields.
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

function stopReasonOf(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined,
): Anthropic.Messages.StopReason | null {
  if (!choice) return null;
  // A refusal is reported in its own field with finish_reason "stop", so it has
  // to be checked before the mapping below or it reads as a clean completion.
  if (choice.message.refusal) return "refusal";
  switch (choice.finish_reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return null;
  }
}

const warnedUsage = new Set<string>();
function warnMissingUsage(model: string): void {
  if (warnedUsage.has(model)) return;
  warnedUsage.add(model);
  console.warn(`[rag:meter] OpenAI response for "${model}" carried no usage — metering it as $0`);
}
