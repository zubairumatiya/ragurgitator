// ---------------------------------------------------------------------------
// AZURE KEY VAULT adapter — the outer layer of the envelope (see envelope.ts).
//
// WHY KEYS AND NOT SECRETS: Key Vault offers both, and only one of them actually
// implements this design. "Secrets" would store the KEK as a blob we read back —
// the key material leaves the vault, so a compromised app server takes the KEK
// with it and the whole two-layer scheme collapses into one layer. "Keys"
// exposes wrapKey/unwrapKey as OPERATIONS: the KEK never leaves, and an attacker
// with app-server access gains only the ability to CALL unwrap while their
// access lasts — revocable, rate-limitable, and logged.
//
// COST: a software-protected RSA key on the standard tier carries no monthly
// per-key charge; operations bill per 10k. With the DEK cache below, a small
// deployment makes very few calls. See docs/user-accounts-plan.md §4.
//
// AUTH: one machine identity serves every user — this is entirely separate from
// how users authenticate to the app (Supabase Auth). DefaultAzureCredential walks
// a chain and resolves it differently per environment, which is why no code here
// branches on deployment:
//
//   local   the developer's `az login` session (needs Key Vault Crypto Officer)
//   Vercel  OIDC federation — Vercel mints a short-lived token per invocation and
//           Azure exchanges it for an access token, via AZURE_TENANT_ID +
//           AZURE_CLIENT_ID and NO client secret. https://vercel.com/docs/oidc/azure
//
// Managed identity is deliberately not in that list: it only exists on Azure
// compute (App Service/Functions/Container Apps/VMs/AKS), not on Vercel. The
// federated path is the better outcome anyway — there is no long-lived secret
// anywhere to leak or rotate, so the DB and the vault stay two genuinely
// independent compromises.
//
// AUDIT: Key Vault diagnostic logging is NOT on by default. Enable diagnostic
// settings to Azure Monitor to get the unwrap trail that this design is partly
// paying for (hardening phase).
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

import { DefaultAzureCredential } from "@azure/identity";
import { CryptographyClient, KeyClient, type KeyWrapAlgorithm } from "@azure/keyvault-keys";

import type { KeyWrapper } from "./envelope";

// RSA-OAEP-256 (SHA-256 mask generation). RSA1_5 is legacy PKCS#1 v1.5 and
// carries the Bleichenbacher padding-oracle history; the A*KW variants require
// an AES KEK, which on Key Vault means the managed-HSM tier.
const WRAP_ALGORITHM: KeyWrapAlgorithm = "RSA-OAEP-256";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Azure Key Vault backs provider-key storage — see docs/user-accounts-plan.md §4.`,
    );
  }
  return value;
}

// Constructed LAZILY, never at import: this module is pulled in by the provider
// clients, and a deployment without Azure configured must fail at the moment a
// key is actually used — with the message above — rather than crashing the whole
// server at boot. Same rationale as the lazy openaiClient()/cohereClient() in
// lib/llm/client.ts.
let _credential: DefaultAzureCredential | undefined;
function credential(): DefaultAzureCredential {
  return (_credential ??= new DefaultAzureCredential());
}

// The CURRENT key version, resolved once per process. Only wrap() needs it —
// unwrap deliberately uses the version recorded on the row instead (see below).
let _currentKeyId: Promise<string> | undefined;
function currentKeyId(): Promise<string> {
  return (_currentKeyId ??= (async () => {
    const client = new KeyClient(requireEnv("AZURE_KEY_VAULT_URL"), credential());
    const key = await client.getKey(requireEnv("AZURE_KEY_VAULT_KEY_NAME"));
    if (!key.id) throw new Error("Key Vault returned a key with no id.");
    return key.id; // versioned URL: https://<vault>/keys/<name>/<version>
  })());
}

// CryptographyClient is bound to one key VERSION, so cache per id rather than
// per vault — unwrap legitimately sees several ids once a rotation has happened.
const _cryptoClients = new Map<string, CryptographyClient>();
function cryptoClient(keyId: string): CryptographyClient {
  let client = _cryptoClients.get(keyId);
  if (!client) {
    client = new CryptographyClient(keyId, credential());
    _cryptoClients.set(keyId, client);
  }
  return client;
}

export const azureKeyWrapper: KeyWrapper = {
  async wrap(dek: Buffer): Promise<{ wrapped: Buffer; kekId: string }> {
    const kekId = await currentKeyId();
    const result = await cryptoClient(kekId).wrapKey(WRAP_ALGORITHM, dek);
    return { wrapped: Buffer.from(result.result), kekId };
  },

  // Unwraps under the key version the row was SEALED with, not the current one.
  // Rotating the KEK therefore doesn't orphan existing rows: they keep opening
  // under their original version until a re-wrap pass moves them forward.
  async unwrap(wrapped: Buffer, kekId: string): Promise<Buffer> {
    const result = await cryptoClient(kekId).unwrapKey(WRAP_ALGORITHM, wrapped);
    return Buffer.from(result.result);
  },
};

// ---------------------------------------------------------------------------
// DEK CACHE
//
// Every open() would otherwise cost a Key Vault round trip (tens of ms, billed).
// This caches the UNWRAPPED DEK — never the API key, which is microseconds to
// re-derive from a cached DEK and is the directly-spendable credential of the
// two. Caching the expensive-and-inert value while re-deriving the cheap-and-
// dangerous one is the whole trade.
//
// Keyed by a hash of the WRAPPED blob, which needs no knowledge of user or
// provider and is exactly correct: identical wrapped bytes always unwrap to
// identical plaintext. It also means a row that gets re-sealed (new DEK) misses
// the cache automatically rather than serving a stale key.
//
// Serverless caveat: on Vercel each instance keeps its own Map and cold starts
// miss, so expect more vault calls than a long-lived server would make.
// ---------------------------------------------------------------------------
const DEFAULT_TTL_MS = 60_000;

export function cachedKeyWrapper(inner: KeyWrapper, ttlMs = DEFAULT_TTL_MS): KeyWrapper {
  const cache = new Map<string, { dek: Buffer; expiresAt: number }>();

  return {
    // Wrapping happens only when a user saves a key — rare, and it must always
    // mint fresh material, so it is deliberately NOT cached.
    wrap: (dek) => inner.wrap(dek),

    async unwrap(wrapped: Buffer, kekId: string): Promise<Buffer> {
      const cacheKey = createHash("sha256").update(wrapped).digest("hex");
      const now = Date.now();

      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now) return hit.dek;

      const dek = await inner.unwrap(wrapped, kekId);
      cache.set(cacheKey, { dek, expiresAt: now + ttlMs });

      // Opportunistic sweep: the map is small (one entry per active user ×
      // provider) and this avoids unbounded growth without a timer keeping the
      // process alive.
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);

      return dek;
    },
  };
}

// The wrapper the app uses. Exported as a getter-style function rather than a
// module constant so nothing touches Azure config at import time.
let _appWrapper: KeyWrapper | undefined;
export function keyWrapper(): KeyWrapper {
  return (_appWrapper ??= cachedKeyWrapper(azureKeyWrapper));
}
