// composeBank — docs/demo-question-bank-plan.md.
//
// The two properties tested here are the two the published build got wrong, and
// neither is visible in a publish that "worked": the census prints a count, and a
// count reads the same whether the twelve came from six documents or one.
//
//   COMPOSITION. The bank is what a guest ADDS, and autotune only has work to do
//     on questions that fail — but a bank of nothing but misses is a caricature of
//     the corpus. Both halves of what a guest can move are weighted by the same
//     QUOTAS, and the first cut of this function (plain worst-first) produced 10
//     misses out of 12 against the real build.
//   SPREAD. A document counter shared across the whole selection, because the
//     bank this replaced was twelve questions about one file — and because
//     interleaving inside each tier separately reaches four documents out of six
//     while looking like it spread.
import assert from "node:assert/strict";
import test from "node:test";

import { composeBank, type BankCandidate } from "./publishedBankCore";

const QUOTAS = [
  { tier: 99, n: 4 },
  { tier: 4, n: 3 },
  { tier: 3, n: 3 },
  { tier: 2, n: 1 },
  { tier: 1, n: 1 },
];

// `n` candidates at one tier, dealt across `docs` documents in the order a
// worst-first query would return them.
function candidates(tier: number, n: number, docs: number): BankCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    questionId: `q${tier}-${i}`,
    documentId: `doc${i % docs}`,
    tier,
  }));
}

const corpus = [
  ...candidates(99, 20, 6),
  ...candidates(4, 8, 6),
  ...candidates(3, 8, 6),
  ...candidates(2, 6, 6),
  ...candidates(1, 40, 6),
];

test("composeBank: fills the quotas rather than taking the worst twelve", () => {
  const picked = composeBank(corpus, QUOTAS, 12);
  assert.equal(picked.length, 12);
  for (const q of QUOTAS) {
    assert.equal(
      picked.filter((p) => p.tier === q.tier).length,
      q.n,
      `tier ${q.tier}`,
    );
  }
});

test("composeBank: spreads across documents instead of draining one", () => {
  const picked = composeBank(corpus, QUOTAS, 12);
  assert.equal(new Set(picked.map((p) => p.documentId)).size, 6);
});

test("composeBank: a one-tier corpus still spreads", () => {
  const picked = composeBank(candidates(99, 30, 5), QUOTAS, 12);
  assert.equal(picked.length, 12);
  assert.equal(new Set(picked.map((p) => p.documentId)).size, 5);
});

test("composeBank: tops up to the cap when a quota comes up short", () => {
  // No rank-3s at all and only two rank-2s: the quotas can fill 4 + 3 + 1 = 8,
  // and the last four come from the rest, worst first.
  const thin = [...candidates(99, 10, 3), ...candidates(4, 3, 3), ...candidates(2, 2, 3)];
  const picked = composeBank(thin, QUOTAS, 12);
  assert.equal(picked.length, 12);
  assert.equal(picked.filter((p) => p.tier === 3).length, 0);
  // Everything it could take at the quota tiers (4 + 3 + 1 = 8), then misses to fill.
  assert.equal(picked.filter((p) => p.tier === 4).length, 3);
  assert.equal(picked.filter((p) => p.tier === 99).length, 8);
});

test("composeBank: never returns more than the cap, or the same question twice", () => {
  const picked = composeBank(corpus, QUOTAS, 5);
  assert.equal(picked.length, 5);
  assert.equal(new Set(picked.map((p) => p.questionId)).size, 5);
});

test("composeBank: an empty corpus composes an empty bank", () => {
  assert.deepEqual(composeBank([], QUOTAS, 12), []);
});

test("composeBank: fewer candidates than the cap returns all of them", () => {
  const thin = [...candidates(99, 2, 2), ...candidates(1, 1, 1)];
  const picked = composeBank(thin, QUOTAS, 12);
  assert.equal(picked.length, 3);
});
