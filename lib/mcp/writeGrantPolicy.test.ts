// Contract tests for the MCP write-grant decision (lib/mcp/writeGrantPolicy.ts).
// The store half is "server-only" and needs a database; these are the parts that
// decide whether a write is allowed, which is why they live in a module the
// runner can load.
//
// THE TWO TESTS THAT MATTER: a grant never outlives the token that asked for it,
// and one capability never authorizes another. Everything else here is a guard
// against the ordinary regression; those two are the security properties.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_GRANT_MS,
  type WriteGrant,
  grantAllows,
  grantExpiry,
  grantIsLive,
  isWriteCapability,
} from "./writeGrantPolicy";

const NOW = 1_800_000_000_000; // ms

const grant = (over: Partial<WriteGrant> = {}): WriteGrant => ({
  clientId: "22222222-2222-2222-2222-222222222222",
  capabilities: ["questions_write"],
  grantedAt: new Date(NOW),
  expiresAt: new Date(NOW + 30 * 60 * 1000),
  ...over,
});

test("a grant never outlives the token: a near-expiry token caps the hour", () => {
  const tokenExp = (NOW + 5 * 60 * 1000) / 1000; // five minutes left, in seconds
  assert.equal(grantExpiry(NOW, tokenExp).getTime(), NOW + 5 * 60 * 1000);
});

test("a long-lived token is capped by the hour, not the other way round", () => {
  const tokenExp = (NOW + 30 * 24 * 60 * 60 * 1000) / 1000;
  assert.equal(grantExpiry(NOW, tokenExp).getTime(), NOW + MAX_GRANT_MS);
});

test("an absent or unreadable token exp buys no extra time", () => {
  assert.equal(grantExpiry(NOW, undefined).getTime(), NOW + MAX_GRANT_MS);
  assert.equal(grantExpiry(NOW, Number.NaN).getTime(), NOW + MAX_GRANT_MS);
});

test("an already-expired token yields an expiry in the past, not a fresh hour", () => {
  const expiry = grantExpiry(NOW, (NOW - 60_000) / 1000);
  assert.ok(expiry.getTime() < NOW);
  assert.equal(grantIsLive(grant({ expiresAt: expiry }), NOW), false);
});

test("one capability does not authorize another", () => {
  const questions = grant({ capabilities: ["questions_write"] });
  assert.equal(grantAllows(questions, "questions_write", NOW), true);
  assert.equal(grantAllows(questions, "config_create", NOW), false);
});

test("an expired grant authorizes nothing, whatever it holds", () => {
  const lapsed = grant({
    capabilities: ["questions_write", "config_create"],
    expiresAt: new Date(NOW - 1),
  });
  assert.equal(grantAllows(lapsed, "questions_write", NOW), false);
  assert.equal(grantAllows(lapsed, "config_create", NOW), false);
});

// A grant belonging to a DIFFERENT client_id is not a row that fails this check
// — the store keys on (user_id, client_id), so it is a row this function never
// receives, and the caller passes null. Same outcome, reached one layer earlier.
test("no grant for this client denies", () => {
  assert.equal(grantAllows(null, "questions_write", NOW), false);
  assert.equal(grantIsLive(null, NOW), false);
});

test("only known capability names survive parsing", () => {
  assert.equal(isWriteCapability("questions_write"), true);
  assert.equal(isWriteCapability("config_create"), true);
  assert.equal(isWriteCapability("delete_everything"), false);
  assert.equal(isWriteCapability(undefined), false);
});
