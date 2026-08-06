// ---------------------------------------------------------------------------
// PROVIDER KEY DAL — the only module that reads or writes user_provider_keys.
//
// The rule the whole file is arranged around: NOTHING here returns a plaintext
// key to a caller that could serialize it. Reads come in two flavours and they
// are deliberately not interchangeable:
//
//   listProviderKeys()  → ProviderKeyDto[]  safe for the client. The SELECT
//                         does not mention ciphertext/wrapped_dek/nonce/
//                         auth_tag, so there is no accidental path from a DB
//                         row into a React prop.
//   openProviderKey()   → SecretKey         server-only, redacts on every
//                         serialization hook, and requires an explicit
//                         .expose() to yield the real string.
//
// A "give me the key as a string" function does not exist on purpose. Phase 4's
// provider clients call openProviderKey() and .expose() inline at construction.
// ---------------------------------------------------------------------------
import "server-only";

import { keyWrapper } from "@/lib/crypto/azureKeyVault";
import { open, seal } from "@/lib/crypto/envelope";
import type { SecretKey } from "@/lib/crypto/secretKey";
import { sql } from "@/lib/db";
import { verifyProviderKey } from "@/lib/auth/providerVerify";

// Mirrors the CHECK constraint in migration 0048. 'local' is absent: the
// transformers.js provider runs in-process and has no credential.
export const PROVIDER_IDS = ["anthropic", "voyage", "openai", "cohere"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

// What each provider is FOR, so the settings page doesn't assume the user
// remembers which vendor does which job here.
//
// No key-format hints ("sk-ant-…") live here any more. They read as a fragment
// of the user's actual stored key while being nothing of the sort — a made-up
// constant. The only key material the UI shows comes from last_four.
export const PROVIDER_META: Record<ProviderId, { label: string; role: string }> = {
  anthropic: { label: "Anthropic", role: "Answer generation" },
  voyage: { label: "Voyage AI", role: "Embeddings (default)" },
  openai: { label: "OpenAI", role: "Alternate embeddings" },
  cohere: { label: "Cohere", role: "Alternate embeddings" },
};

// The client-safe shape. Note what is NOT here: any ciphertext column, and any
// field from which a key could be reconstructed.
export type ProviderKeyDto = {
  provider: ProviderId;
  lastFour: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
};

export async function listProviderKeys(userId: string): Promise<ProviderKeyDto[]> {
  const rows = await sql<
    {
      provider: ProviderId;
      last_four: string;
      created_at: Date;
      updated_at: Date;
      last_verified_at: Date | null;
    }[]
  >`
    select provider, last_four, created_at, updated_at, last_verified_at
      from user_provider_keys
     where user_id = ${userId}
     order by provider
  `;

  return rows.map((r) => ({
    provider: r.provider,
    lastFour: r.last_four,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    lastVerifiedAt: r.last_verified_at?.toISOString() ?? null,
  }));
}

export type SaveResult = { ok: true } | { ok: false; message: string };

// Verify, then seal, then upsert — in that order, and the order matters. A key
// that the provider rejects never reaches the vault or the database at all, so a
// typo costs one failed API call rather than a stored credential that breaks
// something later.
//
// The upsert REPLACES rather than versioning. Keeping the old row would mean
// retaining a live credential the user believes they have rotated away from.
export async function saveProviderKey(
  userId: string,
  provider: ProviderId,
  apiKey: string,
): Promise<SaveResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, message: "Enter an API key." };

  const verified = await verifyProviderKey(provider, trimmed);
  if (!verified.ok) return verified;

  const sealed = await seal(keyWrapper(), userId, provider, trimmed);

  await sql`
    insert into user_provider_keys
      (user_id, provider, ciphertext, wrapped_dek, nonce, auth_tag, kek_id,
       last_four, last_verified_at)
    values
      (${userId}, ${provider}, ${sealed.ciphertext}, ${sealed.wrappedDek},
       ${sealed.nonce}, ${sealed.authTag}, ${sealed.kekId}, ${sealed.lastFour}, now())
    on conflict (user_id, provider) do update set
      ciphertext       = excluded.ciphertext,
      wrapped_dek      = excluded.wrapped_dek,
      nonce            = excluded.nonce,
      auth_tag         = excluded.auth_tag,
      kek_id           = excluded.kek_id,
      last_four        = excluded.last_four,
      last_verified_at = excluded.last_verified_at,
      updated_at       = now()
  `;

  return { ok: true };
}

// Scoped by user_id as well as provider — the WHERE clause is the authorization
// check, so a forged provider value can only ever delete the caller's own row.
export async function deleteProviderKey(userId: string, provider: ProviderId): Promise<void> {
  await sql`
    delete from user_provider_keys
     where user_id = ${userId} and provider = ${provider}
  `;
}

// --- availability (drives every picker's grey-out) ---------------------------
// Which providers this user holds a key for. ONE query returning a Set, rather
// than a hasProviderKey() call per model: the pickers ask about ~11 registry
// models spanning 4 providers, and a per-model query would turn one dropdown
// render into eleven round trips.
//
// Note this touches no ciphertext and no vault — availability is a row-existence
// question, so the greyed-out UI costs a single indexed lookup and never a Key
// Vault operation. That separation is why the picker stays cheap to render.
export async function keyedProviders(userId: string): Promise<Set<ProviderId>> {
  const rows = await sql<{ provider: ProviderId }[]>`
    select provider from user_provider_keys where user_id = ${userId}
  `;
  return new Set(rows.map((r) => r.provider));
}

// Single-provider form, for the call sites that genuinely need just one (the
// generation path's pre-flight check). Prefer keyedProviders() in any loop.
export async function hasProviderKey(userId: string, provider: ProviderId): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one
      from user_provider_keys
     where user_id = ${userId} and provider = ${provider}
  `;
  return rows.length > 0;
}

// SERVER-ONLY read path, for Phase 4's per-user provider clients. Returns null
// when the user has no key for the provider, so callers can distinguish "not
// configured" from "configured but broken" — the latter throws out of open(),
// which is correct: a tampered row must not be treated as a missing one.
export async function openProviderKey(
  userId: string,
  provider: ProviderId,
): Promise<SecretKey | null> {
  const rows = await sql<
    {
      ciphertext: Buffer;
      wrapped_dek: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
      kek_id: string;
      last_four: string;
    }[]
  >`
    select ciphertext, wrapped_dek, nonce, auth_tag, kek_id, last_four
      from user_provider_keys
     where user_id = ${userId} and provider = ${provider}
  `;

  const row = rows[0];
  if (!row) return null;

  return open(keyWrapper(), userId, provider, {
    ciphertext: row.ciphertext,
    wrappedDek: row.wrapped_dek,
    nonce: row.nonce,
    authTag: row.auth_tag,
    kekId: row.kek_id,
    lastFour: row.last_four,
  });
}
