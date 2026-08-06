// ---------------------------------------------------------------------------
// PER-USER PROVIDER CLIENTS — strict BYOK (docs/user-accounts-plan.md §5).
//
// There are no server API keys any more. Every provider client is constructed
// from the calling user's own credential, decrypted out of the vault on demand.
// The module-level singletons this file used to export (built from
// process.env.VOYAGE_API_KEY et al) are gone deliberately: a single shared
// client is a single shared bill, and under multi-tenancy that is both a
// cost-transfer bug and a data-egress one.
//
// The shape is `<provider>For(userId)` — async, because resolving a key means a
// DB read plus an Azure Key Vault unwrap. Callers that have no user in hand
// cannot get a client, which is the point: "which key pays for this call" is now
// answerable at every call site.
//
// MISSING KEY IS NOT AN ERROR CONDITION TO PAPER OVER. `MissingProviderKeyError`
// is thrown rather than returning a keyless client that fails later inside the
// SDK with a provider-worded 401. The distinction matters for the UI: "you have
// not added an OpenAI key" is a settings link, whereas "OpenAI rejected the
// request" is a support problem, and the two must not look alike.
//
// CACHING. Constructed clients are cached per (userId, provider) for the same
// 60s as the DEK cache in azureKeyVault.ts, and for the same reason: a single
// ingest run makes hundreds of embedding calls, and re-unwrapping the DEK for
// each one would bill a Key Vault operation per batch. The TTLs match on purpose
// — a shorter client TTL would just miss into a live DEK cache and gain nothing,
// and a longer one would keep serving a key the user has already rotated away
// from. 60s is the window in which a revoked key still works; that is the
// deliberate trade, and it is bounded.
// ---------------------------------------------------------------------------
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { CohereClientV2 } from "cohere-ai";
import { createRequire } from "module";
import OpenAI from "openai";
import type { VoyageAIClient as VoyageAIClientType } from "voyageai";

import { openProviderKey, type ProviderId } from "@/lib/auth/providerKeys";

// voyageai@0.2.1's ESM build is broken (missing .mjs extensions, directory
// imports — both illegal under strict ESM). The package also ships a working
// CJS build; createRequire forces Node to resolve through the CJS entry
// (package.json#main -> dist/cjs/extended/index.js) instead of the broken
// ESM entry. The `import type` above is erased at compile time so we still
// get full types without loading the broken module.
const requireCjs = createRequire(import.meta.url);
const { VoyageAIClient } = requireCjs("voyageai") as {
  VoyageAIClient: typeof VoyageAIClientType;
};

// Thrown when the user has no key for the provider a call needs. Carries the
// provider id so a route can render "add an Anthropic key in Settings" and link
// there, rather than surfacing a raw SDK 401 the user cannot act on.
export class MissingProviderKeyError extends Error {
  readonly provider: ProviderId;

  constructor(provider: ProviderId) {
    super(`No ${provider} API key. Add one on the Account page to use this feature.`);
    this.name = "MissingProviderKeyError";
    this.provider = provider;
  }
}

export function isMissingProviderKey(err: unknown): err is MissingProviderKeyError {
  return err instanceof MissingProviderKeyError;
}

// --- client cache ------------------------------------------------------------
// Keyed by `${userId}:${provider}`, so one user's client can never be handed to
// another. Values are `unknown` because the four SDK types share no base; each
// accessor below casts back to its own type at the single point where it knows
// what it stored.
const TTL_MS = 60_000;

const clients = new Map<string, { client: unknown; expiresAt: number }>();

async function cached<T>(
  userId: string,
  provider: ProviderId,
  build: (key: string) => T,
): Promise<T> {
  const cacheKey = `${userId}:${provider}`;
  const now = Date.now();

  const hit = clients.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.client as T;

  const secret = await openProviderKey(userId, provider);
  if (!secret) throw new MissingProviderKeyError(provider);

  // .expose() inline in the constructor argument, per the SecretKey contract —
  // the plaintext never lands in a local binding that a stack frame could retain.
  const client = build(secret.expose());
  clients.set(cacheKey, { client, expiresAt: now + TTL_MS });

  // Opportunistic sweep, same idiom as the DEK cache: without it a long-lived
  // dev server accumulates one entry per user per provider forever.
  if (clients.size > 64) {
    for (const [k, v] of clients) if (v.expiresAt <= now) clients.delete(k);
  }

  return client;
}

// Drop a user's cached clients immediately. Called when a key is saved or
// deleted so a rotation takes effect on the next request instead of after the
// TTL — the settings page would otherwise appear not to have worked.
export function invalidateProviderClients(userId: string): void {
  for (const provider of ["anthropic", "voyage", "openai", "cohere"] as const) {
    clients.delete(`${userId}:${provider}`);
  }
}

// --- the four accessors ------------------------------------------------------

export function anthropicFor(userId: string): Promise<Anthropic> {
  return cached(userId, "anthropic", (apiKey) => new Anthropic({ apiKey }));
}

export function voyageFor(userId: string): Promise<VoyageAIClientType> {
  return cached(userId, "voyage", (apiKey) => new VoyageAIClient({ apiKey }));
}

export function openaiFor(userId: string): Promise<OpenAI> {
  return cached(userId, "openai", (apiKey) => new OpenAI({ apiKey }));
}

export function cohereFor(userId: string): Promise<CohereClientV2> {
  return cached(userId, "cohere", (token) => new CohereClientV2({ token }));
}
