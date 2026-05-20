// ---------------------------------------------------------------------------
// LLM / embedding provider client setup.
//
// Single place that constructs and exports the SDK clients the rest of lib/
// calls: `voyageClient` for embeddings (embeddings.ts) and `anthropicClient`
// for answer generation (generator.ts). Swapping providers happens here, in
// one file. API keys are read from process.env — never commit them.
// ---------------------------------------------------------------------------
import Anthropic from "@anthropic-ai/sdk";
import { VoyageAIClient } from "voyageai";

export const voyageClient = new VoyageAIClient({
  apiKey: process.env.VOYAGE_API_KEY,
});

export const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
