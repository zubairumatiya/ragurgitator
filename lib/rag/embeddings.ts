// STEP 3 of ingestion (and also used at query time): EMBED
//
// Turns text into a vector via the embedding model. The SAME model embeds documents
// at ingest time and the user's question at query time, or similarity search is
// meaningless — that's why both paths read config.
//
// `embed()` is a PROVIDER DISPATCHER: it resolves the model's spec from the registry,
// picks the matching adapter, and batches by that provider's cap. Adapters return
// normalized vectors, so downstream cosine reduces to a dot product.
import { assertDemoEmbedBudget } from "@/lib/demo/budget";
import { log } from "@/lib/log";
import { currentSpanIs, span } from "@/lib/observability/span";
import { activeConfig } from "@/lib/rag/activeConfig";
import { modelSpec } from "@/lib/rag/embeddingModels";
import { PROVIDERS, type EmbedRole } from "@/lib/rag/embeddingProviders";

// `document` and `query` nudge the vectors so questions align with the answers
// that satisfy them — each adapter maps this role to its provider's convention.
//
// `model` defaults to the active config's embedding model (the only one used at
// ingest/query time). The per-chunk "try a different model" experiment passes an
// alternate model to embed an ad-hoc candidate pool + queries for in-memory
// re-ranking — never the live index (see lib/rag/eval.runModelTrial).
//
// The `rag.embed` span: opened here for a caller with no cache in front of it
// (always a miss), joined when embedCache.ts has already opened one — that span
// knows how the cache resolved, this one would only know it was asked to pay.
async function embed(
  texts: string[],
  role: EmbedRole,
  model: string = activeConfig().embeddingModel,
): Promise<number[][]> {
  if (currentSpanIs("rag.embed")) return embedInSpan(texts, role, model);
  return span(
    "rag.embed",
    {
      "embed.provider": modelSpec(model).provider,
      "embed.model": model,
      "embed.role": role,
      "embed.count": texts.length,
      "embed.bought": texts.length,
      "embed.cache": "miss",
    },
    () => embedInSpan(texts, role, model),
  );
}

async function embedInSpan(
  texts: string[],
  role: EmbedRole,
  model: string,
): Promise<number[][]> {
  const spec = modelSpec(model);
  const provider = PROVIDERS[spec.provider];

  // THE DEMO'S SPEND CEILING, at the one place every embedding goes through.
  // No-op for a real account; for a guest it is the difference between a
  // bounded bill and a small one (lib/demo/budget.ts).
  await assertDemoEmbedBudget();

  const t0 = performance.now();
  const totalBatches = Math.ceil(texts.length / provider.batchLimit);
  log.info("embeddings start", {
    component: "rag:embeddings",
    count: texts.length,
    role,
    model,
    provider: spec.provider,
    batches: totalBatches,
    batchLimit: provider.batchLimit,
  });

  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += provider.batchLimit) {
    const batch = texts.slice(start, start + provider.batchLimit);
    const batchIdx = start / provider.batchLimit + 1;
    const tBatch = performance.now();

    const out = await provider.embedBatch(batch, role, spec);
    if (out.length !== batch.length) {
      throw new Error(
        `${spec.provider} returned ${out.length} embeddings for ${batch.length} inputs`,
      );
    }
    vectors.push(...out);

    log.debug("embeddings batch", {
      component: "rag:embeddings",
      batch: batchIdx,
      batches: totalBatches,
      vectors: batch.length,
      dim: out[0]?.length,
      ms: Math.round(performance.now() - tBatch),
    });
  }

  log.info("embeddings done", { component: "rag:embeddings", ms: Math.round(performance.now() - t0) });
  return vectors;
}

export function embedTexts(texts: string[], model?: string): Promise<number[][]> {
  if (texts.length === 0) return Promise.resolve([]);
  return embed(texts, "document", model);
}

export async function embedQuery(text: string, model?: string): Promise<number[]> {
  const [vector] = await embed([text], "query", model);
  return vector;
}

// Many queries in one pass, batched by the provider's cap like embedTexts. The
// QUERY role is the whole point: the key-model sweep scores hundreds of question
// texts, and embedding them one call at a time — through embedQuery — asks a
// provider that accepts 128 inputs per request for 128 requests.
export function embedQueries(texts: string[], model?: string): Promise<number[][]> {
  if (texts.length === 0) return Promise.resolve([]);
  return embed(texts, "query", model);
}
