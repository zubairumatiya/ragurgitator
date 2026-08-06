// Contract tests for the Anthropic ⇄ OpenAI Chat Completions translation
// (lib/llm/openaiChat.ts). Pure payload shaping, canned payloads, no SDK and no
// network — the same idiom as lib/batch/providerStatus.test.ts, and for the same
// reason: this is the part of the provider layer most likely to be silently
// wrong, and both transports (meteredMessage and the batch adapter) depend on it
// agreeing with itself. Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { toChatParams, toAnthropicMessage } from "./openaiChat";

// Minimal valid request; each test overrides just the field under study.
function params(
  over: Partial<Anthropic.Messages.MessageCreateParamsNonStreaming> = {},
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model: "gpt-5.6-luna",
    max_tokens: 200,
    messages: [{ role: "user", content: "hi" }],
    ...over,
  } as Anthropic.Messages.MessageCreateParamsNonStreaming;
}

// Minimal valid completion; likewise.
function completion(
  over: Partial<OpenAI.Chat.Completions.ChatCompletion> = {},
  choiceOver: Record<string, unknown> = {},
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl-1",
    model: "gpt-5.6-luna",
    object: "chat.completion",
    created: 0,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "hello", refusal: null },
        ...choiceOver,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    ...over,
  } as OpenAI.Chat.Completions.ChatCompletion;
}

// --- toChatParams ----------------------------------------------------------

test("toChatParams: a string system prompt becomes one leading system message", () => {
  const body = toChatParams(params({ system: "be brief" }));
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages[0], { role: "system", content: "be brief" });
  assert.equal(body.messages[1]?.role, "user");
  // The cap moves to the OpenAI field name; the deprecated one stays unset.
  assert.equal(body.max_completion_tokens, 200);
  assert.equal((body as { max_tokens?: number }).max_tokens, undefined);
});

test("toChatParams: system blocks flatten to one message; cache_control is dropped, text kept", () => {
  const body = toChatParams(
    params({
      system: [
        { type: "text", text: "static prefix", cache_control: { type: "ephemeral" } },
        { type: "text", text: "dynamic tail" },
      ] as Anthropic.Messages.TextBlockParam[],
    }),
  );
  assert.equal(body.messages[0]?.role, "system");
  assert.equal(body.messages[0]?.content, "static prefix\n\ndynamic tail");
  assert.equal(JSON.stringify(body).includes("cache_control"), false);
});

test("toChatParams: reasoning_effort is ALWAYS pinned — 'none' by default and when thinking is disabled", () => {
  // The load-bearing case: max_completion_tokens is a shared budget with
  // invisible reasoning tokens, so an unpinned effort could eat a caller's whole
  // cap and return no text.
  assert.equal(toChatParams(params()).reasoning_effort, "none");
  assert.equal(
    toChatParams(params({ thinking: { type: "disabled" } })).reasoning_effort,
    "none",
  );
});

test("toChatParams: thinking enabled maps to a neutral 'medium', not a derived budget", () => {
  const body = toChatParams(
    params({ thinking: { type: "enabled", budget_tokens: 4096 } }),
  );
  assert.equal(body.reasoning_effort, "medium");
});

test("toChatParams: output_config.format becomes a strict json_schema response_format", () => {
  const schema = {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
    additionalProperties: false,
  };
  const body = toChatParams(
    params({ output_config: { format: { type: "json_schema", schema } } } as never),
  );
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: { name: "response", schema, strict: true },
  });
});

test("toChatParams: passes temperature and stop sequences through only when set", () => {
  const bare = toChatParams(params());
  assert.equal(bare.temperature, undefined);
  assert.equal(bare.stop, undefined);

  const full = toChatParams(params({ temperature: 0, stop_sequences: ["</a>"] }));
  assert.equal(full.temperature, 0); // 0 must survive — it is not "unset"
  assert.deepEqual(full.stop, ["</a>"]);
});

test("toChatParams: tools throw, naming the field", () => {
  assert.throws(
    () => toChatParams(params({ tools: [{ name: "t", input_schema: { type: "object" } }] } as never)),
    /tool use/i,
  );
});

test("toChatParams: a non-text content block throws, naming the block type", () => {
  assert.throws(
    () =>
      toChatParams(
        params({
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
              ],
            },
          ],
        } as never),
      ),
    /"image"/,
  );
});

// --- toAnthropicMessage ----------------------------------------------------

test("toAnthropicMessage: text becomes one text block; usage maps across", () => {
  const msg = toAnthropicMessage(completion());
  assert.deepEqual(msg.content, [{ type: "text", text: "hello", citations: null }]);
  assert.equal(msg.stop_reason, "end_turn");
  assert.equal(msg.usage.input_tokens, 10);
  assert.equal(msg.usage.output_tokens, 4);
  // Cache counters stay null — OpenAI's prompt_tokens INCLUDES cache reads while
  // Anthropic's input_tokens excludes them, so copying would double-count.
  assert.equal(msg.usage.cache_read_input_tokens, null);
});

test("toAnthropicMessage: content null yields an EMPTY content array, not an empty text block", () => {
  // The distinction callers depend on: [] lands on the "no text content" path,
  // [{text:""}] would look like a successful empty answer worth caching.
  const msg = toAnthropicMessage(
    completion({}, { message: { role: "assistant", content: null, refusal: null } }),
  );
  assert.deepEqual(msg.content, []);
});

test("toAnthropicMessage: missing usage meters as zero, warns once, does not throw", () => {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const a = toAnthropicMessage(completion({ usage: undefined, model: "gpt-usage-test" }));
    const b = toAnthropicMessage(completion({ usage: undefined, model: "gpt-usage-test" }));
    assert.equal(a.usage.input_tokens, 0);
    assert.equal(a.usage.output_tokens, 0);
    assert.equal(b.usage.input_tokens, 0);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1); // once per model, not once per call
});

test("toAnthropicMessage: a refusal beats finish_reason 'stop'", () => {
  const msg = toAnthropicMessage(
    completion(
      {},
      { message: { role: "assistant", content: null, refusal: "I can't help with that." } },
    ),
  );
  assert.equal(msg.stop_reason, "refusal");
});

test("toAnthropicMessage: every finish_reason maps per the table", () => {
  const cases: Array<[string, string | null]> = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["something_new", null],
  ];
  for (const [finish, expected] of cases) {
    const msg = toAnthropicMessage(completion({}, { finish_reason: finish }));
    assert.equal(msg.stop_reason, expected, `finish_reason "${finish}"`);
  }
});

test("toAnthropicMessage: no choices at all yields empty content and a null stop reason", () => {
  const msg = toAnthropicMessage(completion({ choices: [] }));
  assert.deepEqual(msg.content, []);
  assert.equal(msg.stop_reason, null);
});
