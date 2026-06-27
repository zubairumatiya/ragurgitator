// ---------------------------------------------------------------------------
// LLM / embedding provider client setup.
//
// Single place that constructs and exports the SDK clients the rest of lib/
// calls: `voyageClient` for embeddings (embeddings.ts) and `anthropicClient`
// for answer generation (generator.ts). Swapping providers happens here, in
// one file. API keys are read from process.env — never commit them.
// ---------------------------------------------------------------------------
import Anthropic from "@anthropic-ai/sdk";
import { CohereClientV2 } from "cohere-ai";
import { createRequire } from "module";
import OpenAI from "openai";
import type { VoyageAIClient as VoyageAIClientType } from "voyageai";

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

export const voyageClient = new VoyageAIClient({
  apiKey: process.env.VOYAGE_API_KEY,
});

export const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Alternate embedding providers (see lib/rag/embeddingModels.ts). Constructed
// LAZILY on first use, not at import: this module is imported widely, and a
// missing OPENAI_API_KEY / COHERE_API_KEY must not crash the Voyage path. The
// client only errors when an actual call is made without a key.
let _openai: OpenAI | undefined;
export function openaiClient(): OpenAI {
  return (_openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}

let _cohere: CohereClientV2 | undefined;
export function cohereClient(): CohereClientV2 {
  return (_cohere ??= new CohereClientV2({ token: process.env.COHERE_API_KEY }));
}
