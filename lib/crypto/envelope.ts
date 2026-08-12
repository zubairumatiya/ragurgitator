// ENVELOPE ENCRYPTION — pure core (no Azure, no DB, no I/O), so it's unit-testable
// against a fake wrapper without provisioning a vault. The decisions that make the
// scheme correct live HERE; the Azure adapter only supplies wrap/unwrap.
//
// Two layers, each protecting the layer below:
//
//   inner   the API key, encrypted with AES-256-GCM under a per-secret DEK
//   outer   that DEK, wrapped by a KEK that never leaves the key vault
//
// The property we're buying is that a DATABASE LEAK YIELDS NOTHING. Ciphertext, a
// wrapped DEK, a nonce and a tag are inert without vault credentials, so a pg_dump,
// a leaked backup, or a compromised read replica stop being incidents. That holds
// regardless of how long plaintext lives in memory, which is why this module
// optimises for correctness rather than for scrubbing RAM.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { SecretKey } from "./secretKey";

// AES-256 key length. Generated fresh per seal() — DEKs are cheap, and a fresh
// one per write makes (key, nonce) reuse unreachable by construction (see below).
const DEK_BYTES = 32;

// 96-bit nonce: the size GCM is specified and optimised for. Longer nonces are
// legal but get hashed down internally (GHASH), which buys nothing and loses the
// guarantee that random 96-bit nonces are collision-safe at our volumes.
const NONCE_BYTES = 12;

const ALGORITHM = "aes-256-gcm";

// What one sealed credential looks like on disk. Maps 1:1 onto the
// user_provider_keys columns in migration 0045.
export type SealedSecret = {
  ciphertext: Buffer;
  wrappedDek: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  // Which KEK wrapped this row's DEK. Stored per row (not read from config) so
  // KEK rotation can re-wrap lazily: a row always knows the key that opens it.
  kekId: string;
  // The only plaintext fragment we ever persist, for the settings UI.
  lastFour: string;
};

// The outer layer, abstracted so the core stays I/O-free. Implemented for real
// by azureKeyVault.ts; the tests supply an in-memory fake.
export interface KeyWrapper {
  // Encrypt a DEK under the current KEK. Returns the wrapped bytes and the id of
  // the exact key VERSION used, which the caller persists alongside.
  wrap(dek: Buffer): Promise<{ wrapped: Buffer; kekId: string }>;
  // Decrypt a DEK under the KEK named by kekId — NOT under whatever key is
  // current, or rotation would orphan every existing row.
  unwrap(wrapped: Buffer, kekId: string): Promise<Buffer>;
}

// TENANT BINDING
//
// AWS KMS has EncryptionContext — key/value pairs that must match on decrypt. Azure
// Key Vault's wrap/unwrap has NO equivalent, so the binding moves entirely into the
// AES-GCM additional authenticated data. AAD is authenticated but not encrypted: it
// doesn't hide anything, it makes decryption FAIL when the context differs.
//
// Effect: a row copied from user A to user B (or from their 'anthropic' row into
// their 'openai' row) fails its tag check instead of decrypting. Without this, a row
// is portable between tenants by anyone with write access to the table.
//
// \x1f (ASCII unit separator) is the delimiter because it cannot occur in a uuid or
// a provider slug, so no pair of (userId, provider) values can be made to produce
// the same AAD as a different pair.
export function aadFor(userId: string, provider: string): Buffer {
  if (!userId || !provider) {
    throw new Error("aadFor requires a non-empty userId and provider.");
  }
  if (userId.includes("\x1f") || provider.includes("\x1f")) {
    throw new Error("userId/provider must not contain the AAD separator.");
  }
  return Buffer.from(`${userId}\x1f${provider}`, "utf8");
}

// Encrypt `apiKey` for one (user, provider). Generates a fresh DEK AND a fresh
// nonce on every call.
//
// That freshness is the load-bearing rule of this module. Reusing a (key, nonce)
// pair under GCM is catastrophic — it leaks the XOR of the two plaintexts and,
// worse, allows an attacker to FORGE authentication tags for that key. Deriving
// a new DEK per write means the pair can never repeat even if a nonce did, so
// the failure mode is unreachable rather than merely avoided.
export async function seal(
  wrapper: KeyWrapper,
  userId: string,
  provider: string,
  apiKey: string,
): Promise<SealedSecret> {
  if (!apiKey) throw new Error("Refusing to seal an empty API key.");

  const aad = aadFor(userId, provider);
  const dek = randomBytes(DEK_BYTES);
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv(ALGORITHM, dek, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const { wrapped, kekId } = await wrapper.wrap(dek);

  return {
    ciphertext,
    wrappedDek: wrapped,
    nonce,
    authTag,
    kekId,
    lastFour: new SecretKey(apiKey).lastFour,
  };
}

// Recover the API key for one (user, provider).
//
// THROWS on any integrity failure — a tampered ciphertext, a wrong tag, or a row
// whose (userId, provider) doesn't match the AAD it was sealed under. Callers
// must NOT catch-and-continue: GCM is CTR mode underneath, so skipping tag
// verification would still produce plaintext-shaped bytes, and "decrypt anyway"
// is exactly how an integrity guarantee becomes decorative.
export async function open(
  wrapper: KeyWrapper,
  userId: string,
  provider: string,
  sealed: SealedSecret,
): Promise<SecretKey> {
  const aad = aadFor(userId, provider);
  const dek = await wrapper.unwrap(sealed.wrappedDek, sealed.kekId);

  const decipher = createDecipheriv(ALGORITHM, dek, sealed.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.authTag);
  const plaintext = Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(), // verifies the tag; throws when it doesn't match
  ]);

  return new SecretKey(plaintext.toString("utf8"));
}
