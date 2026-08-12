// Contract tests for the MCP tool decisions (lib/mcp/toolPolicy.ts). The tool
// bodies are "server-only" and need a database; these are the parts that decide
// what a tool will accept and what it tells a caller when it refuses.
//
// THE ONE THAT MATTERS is the base-model check: it is the guard app/api/configs
// applies to the same creation path, and an MCP tool that skipped it would be a
// way to create configs that can never embed anything.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CHUNK_PAGE,
  MAX_CHUNK_PAGE,
  type SelectableOption,
  approvalUrl,
  baseModelRefusal,
  chunkPage,
  nextOffset,
  settleBatch,
  writeDeniedMessage,
} from "./toolPolicy";

const SITE = "http://localhost:3002";

test("an omitted page falls back to the defaults", () => {
  assert.deepEqual(chunkPage(undefined, undefined), {
    offset: 0,
    limit: DEFAULT_CHUNK_PAGE,
  });
});

test("an oversized limit is clamped, not refused", () => {
  assert.equal(chunkPage(0, 5000).limit, MAX_CHUNK_PAGE);
  assert.equal(chunkPage(0, 0).limit, 1);
  assert.equal(chunkPage(-40, 10).offset, 0);
});

test("a short page ends the paging loop", () => {
  assert.equal(nextOffset(0, 25, 25), 25);
  assert.equal(nextOffset(25, 25, 7), null);
  // The cursor is derived from what came back, so an empty page can never point
  // past the end of a list that shrank between calls.
  assert.equal(nextOffset(50, 25, 0), null);
});

const options: SelectableOption[] = [
  { id: "voyage-4-lite", selectable: true, reason: null },
  { id: "embed-v4", selectable: false, reason: "no Cohere key on this account" },
  { id: "future-model", selectable: false, reason: null },
];

test("a selectable base model is accepted", () => {
  assert.equal(baseModelRefusal(options, "voyage-4-lite"), null);
});

test("an unselectable base model is refused with the store's own reason", () => {
  assert.equal(baseModelRefusal(options, "embed-v4"), "no Cohere key on this account");
  assert.match(baseModelRefusal(options, "future-model") ?? "", /isn't a selectable base model/);
});

test("an unknown base model is refused and the selectable ones are named", () => {
  const refusal = baseModelRefusal(options, "text-embedding-9-imaginary") ?? "";
  assert.match(refusal, /isn't a known base model/);
  assert.match(refusal, /voyage-4-lite/);
  // Naming an unselectable model as an option would send the caller straight
  // into the previous test's refusal.
  assert.doesNotMatch(refusal, /embed-v4/);
});

test("the approval link carries exactly what the page reads", () => {
  const url = new URL(approvalUrl(SITE, "client-abc", ["questions_write"], 1_800_000_000));
  assert.equal(url.pathname, "/account/mcp-write");
  assert.equal(url.searchParams.get("client_id"), "client-abc");
  assert.equal(url.searchParams.get("capabilities"), "questions_write");
  assert.equal(url.searchParams.get("exp"), "1800000000");
});

test("an unknown token expiry is omitted rather than sent as a bad number", () => {
  const url = new URL(approvalUrl(SITE, "client-abc", ["config_create"], undefined));
  assert.equal(url.searchParams.has("exp"), false);
  assert.equal(url.searchParams.get("capabilities"), "config_create");
});

test("a trailing slash on the site URL doesn't double up", () => {
  assert.ok(approvalUrl(`${SITE}/`, "c", ["questions_write"]).startsWith(`${SITE}/account`));
});

// A chunk id from ANOTHER config never resolves — resolveChunksForLabeling
// filters on the active config, so the id is simply absent from the map. Here
// that is `isResolvable` returning false, and the point of the test is that the
// rest of the batch still lands.
test("a chunk id from another config fails its own item, not the batch", async () => {
  const mine = "11111111-1111-1111-1111-111111111111";
  const theirs = "22222222-2222-2222-2222-222222222222";
  const inserted: string[] = [];

  const outcomes = await settleBatch(
    [{ chunkId: mine }, { chunkId: theirs }, { chunkId: mine }],
    (id) => id === mine,
    async (item) => {
      inserted.push(item.chunkId);
      return `q${inserted.length}`;
    },
  );

  assert.deepEqual(
    outcomes.map((o) => o.ok),
    [true, false, true],
  );
  assert.equal(inserted.length, 2);
  assert.match(outcomes[1].error ?? "", /No such chunk in this config/);
  assert.deepEqual(
    outcomes.filter((o) => o.ok).map((o) => o.questionId),
    ["q1", "q2"],
  );
});

test("a failing insert costs its own question and nothing else", async () => {
  const outcomes = await settleBatch(
    [{ chunkId: "a" }, { chunkId: "boom" }, { chunkId: "c" }],
    () => true,
    async (item) => {
      if (item.chunkId === "boom") throw new Error("duplicate key");
      return `q-${item.chunkId}`;
    },
  );

  assert.deepEqual(
    outcomes.map((o) => o.ok),
    [true, false, true],
  );
  // The database's own words, not a flattened "insert failed" — the model can
  // act on "duplicate key" and cannot act on the generic version.
  assert.equal(outcomes[1].error, "duplicate key");
});

// A refusal that doesn't say what to do next is a dead end for both the model
// and the person it would have to ask.
test("a denied write names the capability and the link to fix it", () => {
  const url = approvalUrl(SITE, "client-abc", ["config_create"]);
  const message = writeDeniedMessage("config_create", url);
  assert.match(message, /config_create/);
  assert.match(message, /\/account\/mcp-write/);
});
