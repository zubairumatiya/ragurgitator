// The password rules are the only part of the recovery flows a test can reach:
// verifyOtp and resetPasswordForEmail need a real Supabase project, and the
// integration tier's auth.users shim has no encrypted_password column at all. So
// this covers the boundaries, where an off-by-one silently changes policy.
import assert from "node:assert/strict";
import test from "node:test";

import { allIssues, NewPassword, PASSWORD_HINT } from "./passwordPolicy";

const accepts = (password: string) => NewPassword.safeParse(password).success;

// Reject-side messages, so a test failure names the rule that moved.
function reasons(password: string): string {
  const parsed = NewPassword.safeParse(password);
  assert.equal(parsed.success, false, `expected ${JSON.stringify(password)} to be rejected`);
  return allIssues(parsed.error!);
}

test("NewPassword: length boundary sits at 8, not 7", () => {
  assert.equal(accepts("abcdef1"), false);
  assert.equal(accepts("abcdefg1"), true);
});

test("NewPassword: 72 bytes is the last accepted length", () => {
  // bcrypt truncates past 72, so anything longer has a tail that does nothing.
  assert.equal(accepts("a1".padEnd(72, "x")), true);
  assert.equal(accepts("a1".padEnd(73, "x")), false);
});

test("NewPassword: a letter and a digit are both required", () => {
  assert.equal(accepts("abcdefghij"), false, "letters only");
  assert.equal(accepts("1234567890"), false, "digits only");
  assert.equal(accepts("abcdefgh1"), true);
});

test("NewPassword: symbols and spaces are allowed, not required", () => {
  assert.equal(accepts("correct horse 1"), true);
  assert.equal(accepts("p@ssw0rd!!"), true);
});

test("allIssues: reports every failing rule at once, not just the first", () => {
  // Too short, no letter, no digit — the user should learn all three now rather
  // than one per submit.
  const message = reasons("!!!");
  assert.match(message, /at least 8 characters/i);
  assert.match(message, /one letter/i);
  assert.match(message, /one number/i);
});

test("allIssues: does not repeat a message when a rule fires twice", () => {
  const message = reasons("!!!");
  const sentences = message.split(". ").filter(Boolean);
  assert.equal(new Set(sentences).size, sentences.length);
});

test("PASSWORD_HINT describes rules the schema actually enforces", () => {
  // The hint is shown before the user types; promising less than NewPassword
  // enforces is worse than showing no hint at all.
  assert.equal(accepts("abcdefg1"), true, "8 chars + letter + number is what the hint promises");
  assert.match(PASSWORD_HINT, /8 characters/);
});
