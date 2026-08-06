// Contract tests for provider status mapping + Voyage result parsing
// (lib/batch/providerStatus.ts) — the error-prone parts of the provider layer,
// tested with canned payloads (no SDK, no network). Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapAnthropicStatus,
  mapOpenAiStatus,
  mapVoyageStatus,
  parseOpenAiResults,
  parseVoyageResults,
} from "./providerStatus";

test("mapAnthropicStatus: ended => completed (results fetchable)", () => {
  assert.equal(mapAnthropicStatus("in_progress"), "in_progress");
  assert.equal(mapAnthropicStatus("canceling"), "canceling");
  assert.equal(mapAnthropicStatus("ended"), "completed");
});

test("mapVoyageStatus: running-family collapses; terminals map through; unknown keeps polling", () => {
  for (const s of ["validating", "in_progress", "finalizing"]) {
    assert.equal(mapVoyageStatus(s), "in_progress");
  }
  assert.equal(mapVoyageStatus("completed"), "completed");
  assert.equal(mapVoyageStatus("cancelling"), "canceling");
  assert.equal(mapVoyageStatus("cancelled"), "canceled");
  assert.equal(mapVoyageStatus("expired"), "expired");
  assert.equal(mapVoyageStatus("failed"), "failed");
  // An unrecognized status must NOT terminate a live batch.
  assert.equal(mapVoyageStatus("something_new"), "in_progress");
});

test("parseVoyageResults: maps custom_ids, extracts embeddings, flags errors, skips junk", () => {
  const jsonl = [
    JSON.stringify({ custom_id: "a", response: { body: { data: [{ embedding: [0.1, 0.2] }] } } }),
    "", // blank line ignored
    "{ not valid json", // malformed line skipped
    JSON.stringify({ custom_id: "b", error: { code: "rate_limit" } }),
    JSON.stringify({ custom_id: "c", response: { body: { data: [{ embedding: [0.3] }] } } }),
  ].join("\n");

  const rows = parseVoyageResults(jsonl);
  assert.equal(rows.length, 3); // a, b, c — blank + malformed dropped

  const a = rows.find((r) => r.customId === "a")!;
  assert.equal(a.outcome, "succeeded");
  assert.deepEqual(a.body, [{ embedding: [0.1, 0.2] }]);

  const b = rows.find((r) => r.customId === "b")!;
  assert.equal(b.outcome, "errored");
  assert.equal(b.body, null);
  assert.match(b.error ?? "", /rate_limit/);

  const c = rows.find((r) => r.customId === "c")!;
  assert.equal(c.outcome, "succeeded");
});

test("parseVoyageResults: empty input => no rows", () => {
  assert.deepEqual(parseVoyageResults(""), []);
  assert.deepEqual(parseVoyageResults("\n\n"), []);
});

test("mapOpenAiStatus: finalizing is NOT completed — results aren't fetchable yet", () => {
  for (const s of ["validating", "in_progress", "finalizing"]) {
    assert.equal(mapOpenAiStatus(s), "in_progress");
  }
  assert.equal(mapOpenAiStatus("completed"), "completed");
  // Their spelling is double-l, ours single.
  assert.equal(mapOpenAiStatus("cancelling"), "canceling");
  assert.equal(mapOpenAiStatus("cancelled"), "canceled");
  assert.equal(mapOpenAiStatus("expired"), "expired");
  assert.equal(mapOpenAiStatus("failed"), "failed");
  // As with Voyage: an unrecognized status must NOT terminate a live batch.
  assert.equal(mapOpenAiStatus("something_new"), "in_progress");
});

test("parseOpenAiResults: succeeded rows are translated; non-200 and error rows are flagged", () => {
  // Stand-in for toAnthropicMessage — this test is about row triage, not the
  // translation itself (that has its own suite in lib/llm/openaiChat.test.ts).
  const translate = (c: { id?: string }) => ({ translated: c.id });

  const jsonl = [
    JSON.stringify({ custom_id: "a", response: { status_code: 200, body: { id: "cc-a" } } }),
    "", // blank line ignored
    "{ not valid json", // malformed line skipped
    JSON.stringify({ custom_id: "b", response: { status_code: 429, body: { id: "cc-b" } } }),
    JSON.stringify({ custom_id: "c", error: { code: "invalid_request" } }),
    // A row whose response carries no body at all is not a success.
    JSON.stringify({ custom_id: "d", response: { status_code: 200 } }),
  ].join("\n");

  const rows = parseOpenAiResults(jsonl, translate as never);
  assert.equal(rows.length, 4); // a, b, c, d — blank + malformed dropped

  const a = rows.find((r) => r.customId === "a")!;
  assert.equal(a.outcome, "succeeded");
  assert.deepEqual(a.body, { translated: "cc-a" });

  const b = rows.find((r) => r.customId === "b")!;
  assert.equal(b.outcome, "errored");
  assert.equal(b.body, null);
  assert.match(b.error ?? "", /429/);

  const c = rows.find((r) => r.customId === "c")!;
  assert.equal(c.outcome, "errored");
  assert.match(c.error ?? "", /invalid_request/);

  assert.equal(rows.find((r) => r.customId === "d")!.outcome, "errored");
});

test("parseOpenAiResults: empty input => no rows", () => {
  const translate = () => ({});
  assert.deepEqual(parseOpenAiResults("", translate as never), []);
  assert.deepEqual(parseOpenAiResults("\n\n", translate as never), []);
});
