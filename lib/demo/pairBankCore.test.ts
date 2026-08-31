// pairBankCore — phases 3 and 3b of docs/demo-cache-lab-plan.md.
//
// The reveal hands a guest pairs the publish already paid for. Two properties of
// the payload→row translation carry the whole feature, and neither is visible in
// a passing page:
//
//   1. A REVEALED PAIR MUST BE INDISTINGUISHABLE FROM A GENERATED ONE, which in
//      this table means landing under the same dedupe key insertPairs would have
//      used — canonical orientation, hashes over the texts (0050 made the key
//      `unique (origin_question_id, hash_a, hash_b)`). Get it wrong and the same
//      pair can be stored twice under both orders, which double-counts in every
//      reader downstream and is exactly what canonicalizing exists to prevent.
//   2. THE VERDICT MUST NOT RIDE ALONG. Phase 3b's whole design is that the pair
//      arrives blanked and its audited verdict goes back on the shelf for the
//      screen button to resolve; a PairInsert that carried a verdict field would
//      deliver F3's answer as a fait accompli and leave the button with nothing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { pairInsert, verdictOf, type BankedPairPayload } from "@/lib/demo/pairBankCore";

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// A bank row as lib/demo/clone step 5e writes it: `to_jsonb(row) - 'id'`, so the
// verdict columns and created_at ride along whether the reveal wants them or not.
const banked = (over: Partial<BankedPairPayload> = {}): BankedPairPayload => ({
  origin_question_id: "11111111-1111-1111-1111-111111111111",
  text_a: "What is the refund window?",
  text_b: "How long do I have to ask for my money back?",
  label: "same",
  difficulty: "paraphrase",
  generated_by: "claude-haiku-4-5",
  verdict: "accept",
  verdict_source: "llm",
  judge_model: "claude-sonnet-4-5",
  judge_reason: "one answer serves both",
  judged_at: "2026-08-17T00:00:00.000Z",
  ...over,
});

test("pairInsert stores the pair in the canonical (lower hash first) orientation", () => {
  const p = banked();
  const out = pairInsert(p);
  assert.equal(out.hashA, sha(out.textA));
  assert.equal(out.hashB, sha(out.textB));
  assert.ok(out.hashA < out.hashB, "lower hash must be stored first");
});

test("a payload and its mirror image produce the same row", () => {
  // The label is symmetric, so orientation carries no information — and the
  // dedupe key is over the hashes, so a bank written either way round has to
  // collapse to one row or the guest's count moves for a reason nobody can see.
  const forward = pairInsert(banked());
  const mirrored = pairInsert(
    banked({ text_a: banked().text_b, text_b: banked().text_a }),
  );
  assert.deepEqual(mirrored, forward);
});

test("the hashes are recomputed from the texts, not trusted from the payload", () => {
  // A payload whose hash disagreed with its text would insert a row no later
  // generate could match and no reveal could detect as already present. The
  // payload type does not even carry the hashes, so this asserts the property
  // that makes that safe rather than the absence of a field.
  const out = pairInsert(banked({ text_a: "totally different wording" }));
  assert.ok([out.hashA, out.hashB].includes(sha("totally different wording")));
});

test("pairInsert carries no verdict — the reveal blanks it on purpose", () => {
  const out = pairInsert(banked()) as Record<string, unknown>;
  for (const col of ["verdict", "verdict_source", "judge_model", "judge_reason", "judged_at"]) {
    assert.equal(out[col], undefined, `${col} must not reach the pair insert`);
  }
});

test("verdictOf lifts the five columns off the payload, filling the optional ones", () => {
  assert.deepEqual(verdictOf(banked({ judge_model: undefined })), {
    verdict: "accept",
    verdict_source: "llm",
    judge_model: null,
    judge_reason: "one answer serves both",
    judged_at: "2026-08-17T00:00:00.000Z",
  });
});

test("an unscreened banked pair banks no verdict", () => {
  // The batch generator writes pairs without screening them, so a bank can hold
  // one. Banking a verdict of null would give the guest a screen button that
  // resolves rows to nothing while claiming to have audited them.
  assert.equal(verdictOf(banked({ verdict: null })), null);
});
