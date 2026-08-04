// Contract tests for the envelope-encryption CORE — the properties that make
// stored provider keys safe: round-trip fidelity, tenant binding through AAD,
// integrity rejection on tampering, and fresh key material per write.
//
// Imports only envelope/secretKey (both I/O-free), so it runs with no Azure
// vault, no credentials and no DATABASE_URL — exactly like semanticCache.test.ts
// runs without a database. The KeyWrapper seam exists for this.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import { aadFor, open, seal, type KeyWrapper, type SealedSecret } from "./envelope";
import { SecretKey } from "./secretKey";

// In-memory stand-in for Key Vault. "Wrapping" is a reversible tag + copy: the
// point of these tests is the INNER layer and the orchestration, so the outer
// layer only needs to be faithful about its contract (round-trips, records a
// kekId, and rejects an unknown one).
function fakeWrapper(kekId = "fake-kek/v1"): KeyWrapper {
  return {
    async wrap(dek) {
      return { wrapped: Buffer.concat([Buffer.from("wrapped:"), dek]), kekId };
    },
    async unwrap(wrapped, id) {
      if (id !== kekId) throw new Error(`unknown kek ${id}`);
      return Buffer.from(wrapped.subarray("wrapped:".length));
    },
  };
}

const USER = "3f1a7c2e-8b40-4d9a-9c11-0e5f6a7b8c90";
const OTHER_USER = "9a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
const KEY = "sk-ant-api03-EXAMPLE-not-a-real-key-4f9c";

test("seal/open: round-trips the API key for the same user and provider", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  const recovered = await open(w, USER, "anthropic", sealed);
  assert.equal(recovered.expose(), KEY);
});

test("seal: never stores the plaintext key in any field", async () => {
  const sealed = await seal(fakeWrapper(), USER, "anthropic", KEY);
  // The whole row, serialized, must not contain the key in any encoding.
  const blob = Buffer.concat([
    sealed.ciphertext,
    sealed.wrappedDek,
    sealed.nonce,
    sealed.authTag,
  ]).toString("binary");
  assert.ok(!blob.includes(KEY), "sealed row contains the plaintext key");
  assert.ok(!sealed.kekId.includes(KEY));
});

test("seal: records only the last four characters for display", async () => {
  const sealed = await seal(fakeWrapper(), USER, "anthropic", KEY);
  assert.equal(sealed.lastFour, "4f9c");
});

test("seal: refuses an empty API key", async () => {
  await assert.rejects(() => seal(fakeWrapper(), USER, "anthropic", ""), /empty API key/);
});

// --- tenant binding --------------------------------------------------------
// The reason AAD exists here: Azure Key Vault has no EncryptionContext, so
// without this a row is portable between users by anyone who can write the table.

test("open: rejects a row replayed under a DIFFERENT user", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  await assert.rejects(() => open(w, OTHER_USER, "anthropic", sealed));
});

test("open: rejects a row replayed under a DIFFERENT provider", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  await assert.rejects(() => open(w, USER, "openai", sealed));
});

test("aadFor: distinct (user, provider) pairs can never collide", () => {
  // Without a separator that can't appear in either field, ("ab", "c") and
  // ("a", "bc") would produce identical AAD and become interchangeable.
  assert.notEqual(aadFor("ab", "c").toString(), aadFor("a", "bc").toString());
});

test("aadFor: rejects empty parts and separator injection", () => {
  assert.throws(() => aadFor("", "anthropic"), /non-empty/);
  assert.throws(() => aadFor(USER, ""), /non-empty/);
  assert.throws(() => aadFor(`${USER}\x1fx`, "anthropic"), /separator/);
});

// --- integrity -------------------------------------------------------------
// GCM is CTR underneath: skipping tag verification would still yield plaintext-
// shaped bytes. These assert that we never do.

test("open: rejects a tampered ciphertext", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  const tampered: SealedSecret = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
  tampered.ciphertext[0] ^= 0x01;
  await assert.rejects(() => open(w, USER, "anthropic", tampered));
});

test("open: rejects a tampered auth tag", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  const tampered: SealedSecret = { ...sealed, authTag: Buffer.from(sealed.authTag) };
  tampered.authTag[0] ^= 0x01;
  await assert.rejects(() => open(w, USER, "anthropic", tampered));
});

test("open: rejects a tampered nonce", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  const tampered: SealedSecret = { ...sealed, nonce: Buffer.from(sealed.nonce) };
  tampered.nonce[0] ^= 0x01;
  await assert.rejects(() => open(w, USER, "anthropic", tampered));
});

test("open: surfaces an unknown kek id rather than silently failing open", async () => {
  const w = fakeWrapper();
  const sealed = await seal(w, USER, "anthropic", KEY);
  await assert.rejects(
    () => open(w, USER, "anthropic", { ...sealed, kekId: "rotated-away/v9" }),
    /unknown kek/,
  );
});

// --- fresh key material ----------------------------------------------------
// The load-bearing rule: a repeated (key, nonce) pair under GCM leaks plaintext
// XOR and permits tag forgery. Fresh DEK per write makes it unreachable.

test("seal: generates a fresh DEK and nonce on every write", async () => {
  const w = fakeWrapper();
  const a = await seal(w, USER, "anthropic", KEY);
  const b = await seal(w, USER, "anthropic", KEY);

  assert.notEqual(a.nonce.toString("hex"), b.nonce.toString("hex"));
  assert.notEqual(a.wrappedDek.toString("hex"), b.wrappedDek.toString("hex"));
  // Same plaintext, same user, same provider — but the ciphertexts must differ,
  // or the scheme would leak that two rows hold the same key.
  assert.notEqual(a.ciphertext.toString("hex"), b.ciphertext.toString("hex"));
});

test("seal: uses a 96-bit nonce and a 256-bit DEK", async () => {
  const sealed = await seal(fakeWrapper(), USER, "anthropic", KEY);
  assert.equal(sealed.nonce.length, 12);
  assert.equal(sealed.authTag.length, 16);
  // fakeWrapper prefixes "wrapped:" onto the raw DEK.
  assert.equal(sealed.wrappedDek.length - "wrapped:".length, 32);
});

// --- SecretKey redaction ---------------------------------------------------
// Closing the accidental-log path structurally, so it can't regress silently.

test("SecretKey: redacts through every serialization path", () => {
  const key = new SecretKey(KEY);

  assert.equal(String(key), "[redacted]");
  assert.equal(`bearer ${key}`, "bearer [redacted]");
  assert.equal(JSON.stringify({ key }), '{"key":"[redacted]"}');
  assert.equal(JSON.stringify([key]), '["[redacted]"]');
  assert.ok(!inspect(key).includes(KEY), "util.inspect leaked the key");
  assert.ok(!inspect({ nested: { key } }, { depth: 5 }).includes(KEY));
  // An error message built by interpolation is a very common leak path.
  assert.ok(!new Error(`failed with ${key}`).message.includes(KEY));
  // ...and the value is still recoverable deliberately.
  assert.equal(key.expose(), KEY);
});

test("SecretKey: lastFour withholds a tail from implausibly short values", () => {
  assert.equal(new SecretKey("sk-ant-1234").lastFour, "1234");
  assert.equal(new SecretKey("abcdefgh").lastFour, "efgh");
  assert.equal(new SecretKey("short").lastFour, "");
});

test("SecretKey: refuses to wrap an empty value", () => {
  assert.throws(() => new SecretKey(""), /empty/);
});
