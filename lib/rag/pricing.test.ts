// Contract tests for the PRICING lookup — specifically that a versioned model id
// prices the same as its date-less alias. This is the difference between the
// batch lever accruing real dollars and silently accruing $0 forever: the price
// table is keyed on aliases, but a provider response may echo a resolved dated
// id. pricing.ts is dependency-free, so this runs without a DATABASE_URL.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { costEmbed, costLlm, estimateTokens, estimateTokensAll } from "./pricing";

test("costLlm: a dated model id prices identically to its alias", () => {
  const alias = costLlm("claude-haiku-4-5", 1_000_000, 1_000_000);
  const dated = costLlm("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
  assert.equal(alias, 1 + 5); // $1/M in + $5/M out
  assert.equal(dated, alias);
});

test("costLlm: known aliases price at their table rates", () => {
  assert.equal(costLlm("claude-sonnet-4-6", 1_000_000, 1_000_000), 3 + 15);
  assert.equal(costLlm("claude-opus-4-8", 1_000_000, 1_000_000), 5 + 25);
});

test("costLlm: prefix matching requires a '-' boundary, not a bare substring", () => {
  // "claude-haiku-4-52" must NOT resolve to the "claude-haiku-4-5" row — it's a
  // different model, and silently pricing it as haiku would be a wrong number
  // rather than an honest 0.
  assert.equal(costLlm("claude-haiku-4-52", 1_000_000, 1_000_000), 0);
});

test("costLlm: the longest matching prefix wins", () => {
  // "claude-opus-4-8-20260101" extends "claude-opus-4-8"; no shorter key may
  // capture it. (Guards against a future table gaining nested aliases.)
  assert.equal(costLlm("claude-opus-4-8-20260101", 1_000_000, 0), 5);
});

test("costLlm: a genuinely unknown model costs 0 rather than a fabricated price", () => {
  assert.equal(costLlm("some-other-vendor-model", 1_000_000, 1_000_000), 0);
});

test("costEmbed: a dated embed model id prices identically to its alias", () => {
  assert.equal(costEmbed("voyage-4-lite", 1_000_000), 0.02);
  assert.equal(costEmbed("voyage-4-lite-20260101", 1_000_000), 0.02);
});

test("costEmbed: a local (free) model is 0 without tripping the unknown path", () => {
  assert.equal(costEmbed("bge-m3", 1_000_000), 0);
});

test("estimateTokens: ~4 chars per token, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokensAll(["abcd", "abcd"]), 2);
});
