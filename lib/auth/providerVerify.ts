// ---------------------------------------------------------------------------
// SAVE-TIME KEY VERIFICATION.
//
// One cheap live call per provider, made with the CANDIDATE key before it is
// sealed. A key that doesn't work is rejected at the settings form rather than
// being stored and then failing during an ingest run, where the error surfaces
// three screens away from the thing that caused it.
//
// Every client here is constructed ad hoc from the candidate key and thrown
// away. Nothing touches the shared clients in lib/llm/client.ts — those still
// read process.env until Phase 4 makes them per-user, and reusing them would
// verify the SERVER's key while the user watches their own typo get accepted.
//
// The calls are chosen to be the cheapest thing that still proves the key is
// accepted: a model list where the provider offers one, a single-token embed
// where it doesn't. None of them bill meaningfully.
// ---------------------------------------------------------------------------
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { CohereClientV2 } from "cohere-ai";
import { createRequire } from "module";
import OpenAI from "openai";
import type { VoyageAIClient as VoyageAIClientType } from "voyageai";

import type { ProviderId } from "@/lib/auth/providerKeys";

// Same CJS workaround as lib/llm/client.ts — voyageai@0.2.x ships a broken ESM
// build. See the comment there.
const requireCjs = createRequire(import.meta.url);
const { VoyageAIClient } = requireCjs("voyageai") as {
  VoyageAIClient: typeof VoyageAIClientType;
};

// Cheapest real embed model per provider, used only to prove the key works.
const VOYAGE_PROBE_MODEL = "voyage-4-lite";
const COHERE_PROBE_MODEL = "embed-v4.0";

const VERIFIERS: Record<ProviderId, (apiKey: string) => Promise<void>> = {
  async anthropic(apiKey) {
    // models.list is free and requires a valid key.
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
  },

  async openai(apiKey) {
    await new OpenAI({ apiKey }).models.list();
  },

  async voyage(apiKey) {
    // No list endpoint, so the smallest possible embed stands in.
    await new VoyageAIClient({ apiKey }).embed({
      input: ["ok"],
      model: VOYAGE_PROBE_MODEL,
      inputType: "document",
    });
  },

  async cohere(apiKey) {
    await new CohereClientV2({ token: apiKey }).embed({
      model: COHERE_PROBE_MODEL,
      inputType: "search_document",
      texts: ["ok"],
      embeddingTypes: ["float"],
    });
  },
};

export type VerifyResult = { ok: true } | { ok: false; message: string };

// Never throws: a verification failure is an expected outcome of a settings
// form, not an exception. The provider's own message is deliberately NOT
// forwarded — SDK errors have a habit of echoing the request back, and the
// request contains the key.
export async function verifyProviderKey(
  provider: ProviderId,
  apiKey: string,
): Promise<VerifyResult> {
  try {
    await VERIFIERS[provider](apiKey);
    return { ok: true };
  } catch (e) {
    // Log the shape of the failure without the payload, so a genuinely broken
    // integration is still debuggable from the server log.
    console.warn(
      `[providerVerify] ${provider} rejected a candidate key: ${
        e instanceof Error ? e.name : typeof e
      }`,
    );
    return {
      ok: false,
      message: `${provider} rejected that key. Check it was copied in full and has not been revoked.`,
    };
  }
}
