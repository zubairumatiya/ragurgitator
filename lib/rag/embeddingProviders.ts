// ---------------------------------------------------------------------------
// EMBEDDING PROVIDER ADAPTERS (see docs/embedding-providers-plan.md, E2/E3).
//
// One adapter per provider. Each maps the abstract role ("document" | "query")
// to that provider's convention, applies the provider's batch cap, and
// normalizes the response to number[][] in input order. The dispatcher in
// embeddings.ts is the only caller; the rest of lib/ keeps using
// embedTexts/embedQuery and never learns a provider's quirks.
//
// Adding a provider = one adapter here + a PROVIDERS entry + registry rows. The
// non-Voyage adapters are inert until a key/weights exist (lazy clients), so
// this file is safe to ship before any of them is switched on.
// ---------------------------------------------------------------------------
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

import { cohereClient, openaiClient, voyageClient } from "@/lib/llm/client";
import type { EmbeddingModelSpec, EmbeddingProviderId } from "@/lib/rag/embeddingModels";

export type EmbedRole = "document" | "query";

export interface EmbeddingProvider {
  // Provider's per-call input cap; the dispatcher slices texts into this size.
  batchLimit: number;
  // Embed exactly one batch (≤ batchLimit), returning vectors in input order.
  embedBatch(
    texts: string[],
    role: EmbedRole,
    spec: EmbeddingModelSpec,
  ): Promise<number[][]>;
}

// --- Voyage (the default) — byte-identical to the previous embeddings.ts body:
// inputType = role, sort data by `index` so vectors line up with inputs, reject
// empty/short responses. Voyage returns unit-length vectors. ---------------
const voyageProvider: EmbeddingProvider = {
  batchLimit: 128,
  async embedBatch(texts, role, spec) {
    const response = await voyageClient.embed({
      input: texts,
      model: spec.apiModel,
      inputType: role,
    });
    const data = response.data;
    if (!data || data.length !== texts.length) {
      throw new Error(
        `Voyage returned ${data?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((item) => {
      if (!item.embedding) throw new Error("Voyage returned an empty embedding");
      return item.embedding;
    });
  },
};

// --- OpenAI — role is ignored; `dimensions` shrinks the Matryoshka models below
// their native size (E7) so the output matches the registry dim. -------------
const openaiProvider: EmbeddingProvider = {
  batchLimit: 2048,
  async embedBatch(texts, _role, spec) {
    const res = await openaiClient().embeddings.create({
      model: spec.apiModel,
      input: texts,
      // text-embedding-3-* support `dimensions`; native is 3072 so only send it
      // when we want a smaller output. Omitted for any model whose registry dim
      // equals its native size.
      dimensions: spec.dimension < 3072 ? spec.dimension : undefined,
    });
    return [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  },
};

// --- Cohere — input_type is REQUIRED for v3/v4; request float embeddings and
// read them back from the by-type response. ----------------------------------
const cohereProvider: EmbeddingProvider = {
  batchLimit: 96,
  async embedBatch(texts, role, spec) {
    const res = await cohereClient().embed({
      model: spec.apiModel,
      inputType: role === "query" ? "search_query" : "search_document",
      texts,
      embeddingTypes: ["float"],
    });
    const floats = res.embeddings?.float;
    if (!floats || floats.length !== texts.length) {
      throw new Error(
        `Cohere returned ${floats?.length ?? 0} float embeddings for ${texts.length} inputs`,
      );
    }
    return floats;
  },
};

// --- Local (transformers.js, in-process) — lazy pipeline per model, CLS pooling
// + normalize. mxbai wants a query prefix; bge-m3 does not. Small batches to cap
// memory. Won't run in a Vercel function (weights too big) — local-only. ------
const MXBAI_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

const localPipelines = new Map<string, Promise<FeatureExtractionPipeline>>();
function getLocalPipeline(apiModel: string): Promise<FeatureExtractionPipeline> {
  let p = localPipelines.get(apiModel);
  if (!p) {
    p = pipeline("feature-extraction", apiModel);
    localPipelines.set(apiModel, p);
  }
  return p;
}

const localProvider: EmbeddingProvider = {
  batchLimit: 16,
  async embedBatch(texts, role, spec) {
    const extractor = await getLocalPipeline(spec.apiModel);
    const inputs =
      role === "query" && spec.id === "mxbai-embed-large"
        ? texts.map((t) => MXBAI_QUERY_PREFIX + t)
        : texts;
    const output = await extractor(inputs, { pooling: "cls", normalize: true });
    return output.tolist() as number[][];
  },
};

export const PROVIDERS: Record<EmbeddingProviderId, EmbeddingProvider> = {
  voyage: voyageProvider,
  openai: openaiProvider,
  cohere: cohereProvider,
  local: localProvider,
};
