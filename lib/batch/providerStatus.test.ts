// Contract tests for provider status mapping + Voyage result parsing
// (lib/batch/providerStatus.ts) — the error-prone parts of the provider layer,
// tested with canned payloads (no SDK, no network). Run with: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapAnthropicStatus, mapVoyageStatus, parseVoyageResults } from "./providerStatus";

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
