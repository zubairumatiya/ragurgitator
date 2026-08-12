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
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

import { activeUserId } from "@/lib/auth/userScope";
import { cohereFor, openaiFor, voyageFor } from "@/lib/llm/client";
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
    const voyageClient = await voyageFor(activeUserId());
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
    const openaiClient = await openaiFor(activeUserId());
    const res = await openaiClient.embeddings.create({
      model: spec.apiModel,
      input: texts,
      // text-embedding-3-* support `dimensions`, but only DOWNWARD: send it just
      // when the registry asks for less than the model's own native width.
      // Compared against spec.nativeDimension, not a literal — a hardcoded 3072
      // (large's native size) sent a pointless dimensions: 1536 to
      // text-embedding-3-small, and would send an invalid above-native value to
      // any model registered between its native size and 3072.
      dimensions: spec.dimension < spec.nativeDimension ? spec.dimension : undefined,
    });
    return [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  },
};

// --- Cohere — input_type is REQUIRED for v3/v4; request float embeddings and
// read them back from the by-type response. ----------------------------------

// Which Cohere models accept `output_dimension`. Cohere documents it as "only
// available for embed-v4 and newer models" — the v3 family has one fixed width.
//
// Deliberately an allow-list of what we've checked, not a "v4 or later" version
// comparison: the docs describe non-support rather than promising a 4xx, so a
// v3 model handed the parameter may simply IGNORE it and return its native
// width under a registry row claiming something narrower — a dimension mismatch
// nothing downstream would catch until it reached a vector table. Gating here
// means the app never depends on Cohere to reject it. Widen this only after
// checking a new model's docs.
function acceptsOutputDimension(apiModel: string): boolean {
  return apiModel.startsWith("embed-v4");
}

const cohereProvider: EmbeddingProvider = {
  batchLimit: 96,
  async embedBatch(texts, role, spec) {
    const cohereClient = await cohereFor(activeUserId());
    const res = await cohereClient.embed({
      model: spec.apiModel,
      inputType: role === "query" ? "search_query" : "search_document",
      texts,
      embeddingTypes: ["float"],
      // Pin the width for the models that let us. Without it embed-v4-1024 gets
      // Cohere's 1536 default back under a registry row that says 1024. Sent for
      // every v4 row, including the one already at 1536: an explicit value can't
      // drift when a provider changes its default, and it makes the registry's
      // `dimension` the single thing that decides the vector width.
      outputDimension: acceptsOutputDimension(spec.apiModel) ? spec.dimension : undefined,
      // Explicit rather than inherited from the provider default, because the
      // two families disagree about how much this matters: v4 takes 128K tokens
      // and will never hit the cap on our chunk sizes, while the v3 family caps
      // at 512 (~2,000 characters) and truncates most real chunks. "END" keeps
      // the head of the chunk — the lead sentences carry the topic, and a
      // consistent rule beats one that varies with the SDK's default. The
      // alternative, truncate: "NONE", turns an over-long chunk into a failed
      // batch mid-ingest; the v3 specs carry a `note` so the picker can warn
      // about the quality cost instead.
      truncate: "END",
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
