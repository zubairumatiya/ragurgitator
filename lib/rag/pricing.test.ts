// Contract tests for the PRICING lookup — specifically that a versioned model id
// prices the same as its date-less alias. This is the difference between the
// batch lever accruing real dollars and silently accruing $0 forever: the price
// table is keyed on aliases, but a provider response may echo a resolved dated
// id. pricing.ts is dependency-free, so this runs without a DATABASE_URL.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { EMBEDDING_MODELS } from "./embeddingModels";
import {
  costEmbed,
  costLlm,
  EMBED_RATES,
  embedRate,
  estimateTokens,
  estimateTokensAll,
  estimateTokensFromChars,
  LEVERS,
} from "./pricing";

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

test("costEmbed: an UNVERIFIED rate still costs at its number, it does not dash to 0", () => {
  // The display/costing split (EmbedRate.verified): the Appraise → Models rate
  // card renders "—" for text-embedding-3-large because OpenAI's own pages
  // disagree, but accounting must keep using 0.13. If this ever returns 0, the
  // rate card's caution has leaked into the ledger and embed spend under that
  // model silently vanishes.
  assert.equal(EMBED_RATES["text-embedding-3-large"].verified, false);
  assert.equal(costEmbed("text-embedding-3-large", 1_000_000), 0.13);
});

test("EMBED_RATES: every registered embedding model has a rate", () => {
  // A model in EMBEDDING_MODELS with no rate entry costs $0 forever (costEmbed's
  // unknown path) — the under-count is silent apart from one console warn. This
  // is the guard that adding a model to the registry can't skip pricing it.
  for (const id of Object.keys(EMBEDDING_MODELS)) {
    assert.ok(embedRate(id), `${id} is registered but has no EMBED_RATES entry`);
  }
});

test("EMBED_RATES: a free tier is a positive token allowance or absent, never 0", () => {
  // freeTierM is rendered as "200M"/"50M"/"—". A 0 would render as a free tier
  // that grants nothing, which is a different (and wrong) claim from "none".
  for (const [id, rate] of Object.entries(EMBED_RATES)) {
    if (rate.freeTierM !== null) {
      assert.ok(rate.freeTierM > 0, `${id} has a zero free tier; use null instead`);
    }
  }
});

test("estimateTokens: ~4 chars per token, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokensAll(["abcd", "abcd"]), 2);
});

test("estimateTokensFromChars: agrees with estimateTokens on the same text", () => {
  // The re-ingest skip prices a run it never loads, via a char COUNT. If these
  // two ever diverge, a skipped document and an embedded one of identical size
  // would be priced differently — the exact comparison the lever exists to make.
  for (const text of ["", "abc", "abcd", "abcde", "x".repeat(1234)]) {
    assert.equal(estimateTokensFromChars(text.length), estimateTokens(text));
  }
});

test("LEVERS: every lever id has metadata, so no saving is dropped on read", () => {
  // getCostsReport filters rows whose lever isn't in LEVERS — a recorded lever
  // missing an entry here would silently vanish from the ledger rather than
  // showing up unlabeled.
  for (const [id, meta] of Object.entries(LEVERS)) {
    assert.ok(meta.label.length > 0, `${id} has no label`);
    assert.ok(["realized", "structural"].includes(meta.category), `${id} category`);
    assert.ok(["exact", "estimate"].includes(meta.basis), `${id} basis`);
  }
  assert.ok(LEVERS.eval_embed_reuse, "eval_embed_reuse must be registered to be reportable");
  assert.ok(LEVERS.question_reuse, "question_reuse must be registered to be reportable");
});

test("LEVERS: question_reuse is realized and estimate-based", () => {
  // Realized, not structural: it sits behind the Savings toggle, so its
  // counterfactual is this same config with reuse switched off. Estimate,
  // because the banked usage is the generating call's real tokens split across
  // the N questions that call returned.
  assert.equal(LEVERS.question_reuse.category, "realized");
  assert.equal(LEVERS.question_reuse.basis, "estimate");
});

test("LEVERS: eval_embed_reuse is structural and estimate-based", () => {
  // The collision floor reuses banked eval vectors instead of re-embedding the
  // question bank: nothing was ever billed and un-billed, so it belongs in the
  // structural view, and its tokens are char/4 estimates from question text.
  assert.equal(LEVERS.eval_embed_reuse.category, "structural");
  assert.equal(LEVERS.eval_embed_reuse.basis, "estimate");
});

test("eval_embed_reuse: an unknown embedding model banks $0, not a guess", () => {
  // computeCollisionFloor prices whatever the active config's embeddingModel is.
  // If that model isn't in the table the lever must under-count silently rather
  // than invent a rate — same contract every other embed-priced lever relies on.
  assert.equal(costEmbed("some-unlisted-embedder", estimateTokens("x".repeat(400))), 0);
});
