// PROVIDER AVAILABILITY — "can this user embed/generate with provider X right
// now?" (docs/user-accounts-plan.md §5).
//
// This replaces the old `isProviderAvailable()` env read in embeddingModels.ts.
// Under strict BYOK the answer is per-user and lives in the database, so it is
// necessarily async — which is why it moved out of the registry module. The
// registry stays a pure, importable-anywhere data table; the IO lives here.
//
// TWO DIFFERENT KINDS OF "AVAILABLE", deliberately not unified:
//
//   API providers (voyage/openai/cohere/anthropic) — a CREDENTIAL question.
//     Per-user, DB-backed, and the fix is "add a key in Settings".
//   local — a HOST CAPABILITY question. transformers.js downloads
//     multi-hundred-MB weights and cannot run on a serverless function, so it
//     stays gated on process.env.LOCAL_EMBEDDINGS. That is not a credential and
//     must not become one: no user can fix it from the UI, and every user on a
//     given deployment gets the same answer.
//
// The reason strings differ accordingly, and that difference is the whole point
// of keeping the two paths apart — telling a user to "add a local key in
// Settings" would send them somewhere that cannot help them.
import "server-only";

import { keyedProviders, type ProviderId } from "@/lib/auth/providerKeys";
import { activeUserId } from "@/lib/auth/userScope";
import type { EmbeddingProviderId } from "@/lib/rag/embeddingModels";

// Every provider the ACTIVE user can use right now: their keyed API providers,
// plus `local` when this deployment enables it. One DB query.
//
// Callers must already be inside a withUser scope — activeUserId() throws
// otherwise, which is the correct failure: a picker rendered with no user would
// otherwise silently grey out everything and look like "you have no keys".
// The union covers both registries: every credentialed ProviderId (including
// `anthropic`, which the LLM picker asks about but no embedding model uses) plus
// `local`, which only the embedding registry has.
export type AvailableProvider = ProviderId | EmbeddingProviderId;

export async function availableProviders(): Promise<Set<AvailableProvider>> {
  const keyed = await keyedProviders(activeUserId());
  const available = new Set<AvailableProvider>(keyed);
  if (process.env.LOCAL_EMBEDDINGS) available.add("local");
  return available;
}

// The matching `unavailableReason(provider)` is pure, so it lives with the
// registry in embeddingModels.ts rather than here — this module is server-only
// and the reason strings are needed wherever options are rendered.
