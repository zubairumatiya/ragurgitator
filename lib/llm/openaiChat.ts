// ANTHROPIC ⇄ OPENAI CHAT COMPLETIONS TRANSLATION — pure, no client, no IO.
//
// Extracted from lib/rag/meter.ts because TWO transports need the same
// translation: the synchronous call there and the batch adapter in
// lib/batch/providers.ts, which builds the same request bodies as JSONL lines.
// Sharing the pair is what makes the batch path trustworthy — a batched
// question-generation call and a synchronous one are the SAME request by
// construction, not by two authors agreeing.
//
// CHAT COMPLETIONS, NOT THE RESPONSES API. The GPT-5 family serves both, and Chat
// Completions is by far the smaller diff from the Anthropic shape — same
// system-then-turns message list, same single text answer, same flat usage
// counters. The Responses API's item/output model would need a second translation
// layer to arrive at the same place.
//
// Four disagreements to normalise:
//
//   system prompt   top-level `system`   → a leading {role:"system"} message
//   output cap      `max_tokens`         → `max_completion_tokens`
//   response body   `content[]` blocks   → `choices[0].message.content`
//   usage           input_/output_tokens → prompt_/completion_tokens
//
// Anything this translation CANNOT carry across throws rather than being dropped
// silently. A prompt that quietly lost its schema constraint or its tools would
// come back as unparseable prose from a model that looks like it just did a bad
// job — a much worse afternoon than a thrown error naming the field.
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

export function toChatParams(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  if (params.tools?.length) {
    throw new Error("openaiChat: tool use is not translated to OpenAI yet.");
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
    // one that also counts reasoning tokens against the cap — which is exactly
    // why reasoning_effort is pinned below.
    max_completion_tokens: params.max_tokens,
  };

  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.stop_sequences?.length) body.stop = params.stop_sequences;

  // REASONING EFFORT IS ALWAYS SET, never left to the model's default.
  //
  // Anthropic's `max_tokens` caps VISIBLE output; OpenAI's `max_completion_tokens`
  // is a shared budget that invisible reasoning tokens are also drawn from. Left on
  // a reasoning default, a caller's cap means two different things on the two legs —
  // and the tightest cap in the app (the 200-token judge) can be consumed entirely
  // by reasoning, returning `content: null` with finish_reason "length", i.e. a judge
  // that silently records nothing. Pinning effort to "none" makes every existing
  // max_tokens value stay correct after translation.
  //
  // The "enabled" branch is defensive only — no caller passes it today. It maps to
  // "medium" rather than deriving an effort level from Anthropic's token budget,
  // which would be an invented equivalence.
  body.reasoning_effort = params.thinking?.type === "enabled" ? "medium" : "none";

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
export function flattenText(
  content: string | Array<Anthropic.Messages.TextBlockParam> | Anthropic.Messages.MessageParam["content"] | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type !== "text") {
        throw new Error(`openaiChat: cannot send a "${block.type}" block to OpenAI.`);
      }
      return block.text;
    })
    .join("\n\n");
}

export function toAnthropicMessage(
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
  console.warn(`[rag:openaiChat] OpenAI response for "${model}" carried no usage — metering it as $0`);
}
