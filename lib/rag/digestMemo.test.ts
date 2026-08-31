// Contract tests for the digest-keyed memo. The whole safety argument for
// caching a guest's own rows across requests is "a changed row means a changed
// digest means a miss", so the thing worth pinning is that a differing digest
// really does miss — including the empty case, which is the one a sentinel could
// quietly get wrong. Dependency-free, so this runs without a DATABASE_URL.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { cacheKey, DigestMemo } from "./digestMemo";

test("a matching digest hits, a different one misses", () => {
  const memo = new DigestMemo<string[]>();
  memo.set("u1", "aaa", ["one"]);
  assert.deepEqual(memo.get("u1", "aaa"), ["one"]);
  assert.equal(memo.get("u1", "bbb"), undefined);
});

test("an empty result is cached, not treated as unknown", () => {
  const memo = new DigestMemo<string[]>();
  memo.set("u1", null, []);
  assert.deepEqual(memo.get("u1", null), []);
  // …and cannot be reached by a real digest, nor a real one by null.
  assert.equal(memo.get("u1", "aaa"), undefined);
  memo.set("u1", "aaa", ["one"]);
  assert.equal(memo.get("u1", null), undefined);
});

test("keys do not leak across users", () => {
  const memo = new DigestMemo<string[]>();
  memo.set(cacheKey("alice"), "same", ["alice's row"]);
  // Same digest, different user: a hit here would be the cross-guest leak the
  // per-user key exists to make impossible.
  assert.equal(memo.get(cacheKey("bob"), "same"), undefined);
});

test("a re-set under a new digest replaces rather than accumulating", () => {
  const memo = new DigestMemo<string[]>();
  memo.set("u1", "aaa", ["one"]);
  memo.set("u1", "bbb", ["two"]);
  assert.equal(memo.size, 1);
  assert.equal(memo.get("u1", "aaa"), undefined);
  assert.deepEqual(memo.get("u1", "bbb"), ["two"]);
});

test("eviction is bounded and oldest-first", () => {
  const memo = new DigestMemo<number[]>(2);
  memo.set("a", "d", [1]);
  memo.set("b", "d", [2]);
  memo.set("c", "d", [3]);
  assert.equal(memo.size, 2);
  assert.equal(memo.get("a", "d"), undefined);
  assert.deepEqual(memo.get("c", "d"), [3]);
});

test("a hit refreshes recency, so a live key is not evicted under an idle one", () => {
  const memo = new DigestMemo<number[]>(2);
  memo.set("a", "d", [1]);
  memo.set("b", "d", [2]);
  memo.get("a", "d");
  memo.set("c", "d", [3]);
  assert.deepEqual(memo.get("a", "d"), [1]);
  assert.equal(memo.get("b", "d"), undefined);
});

test("forget clears one key or all of them", () => {
  const memo = new DigestMemo<number[]>();
  memo.set("a", "d", [1]);
  memo.set("b", "d", [2]);
  memo.forget("a");
  assert.equal(memo.get("a", "d"), undefined);
  assert.deepEqual(memo.get("b", "d"), [2]);
  memo.forget();
  assert.equal(memo.size, 0);
});

test("cacheKey scopes below the user without letting parts run together", () => {
  assert.notEqual(cacheKey("ab", "c"), cacheKey("a", "bc"));
  assert.equal(cacheKey("u", null), cacheKey("u", ""));
});
