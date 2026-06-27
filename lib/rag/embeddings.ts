// ---------------------------------------------------------------------------
// STEP 3 of ingestion (and also used at query time): EMBED
//
// Turns text into a vector (number[]) via the embedding model. The SAME model
// embeds documents at ingest time and the user's question at query time, or
// similarity search is meaningless — that's why both paths read config.
//
// `embed()` is a PROVIDER DISPATCHER: it resolves the model's spec from the
// registry (lib/rag/embeddingModels.ts), picks the matching adapter
// (lib/rag/embeddingProviders.ts), and batches by that provider's cap. Adapters
// return normalized vectors (Voyage/OpenAI/Cohere already do; the local adapter
// passes normalize:true), so downstream cosine reduces to a dot product.
// ---------------------------------------------------------------------------
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
async function embed(
  texts: string[],
  role: EmbedRole,
  model: string = activeConfig().embeddingModel,
): Promise<number[][]> {
  const spec = modelSpec(model);
  const provider = PROVIDERS[spec.provider];

  const t0 = performance.now();
  const totalBatches = Math.ceil(texts.length / provider.batchLimit);
  console.log(
    `[rag:embeddings] embedding ${texts.length} ${role}(s) with ${model} (${spec.provider}) in ${totalBatches} batch(es) of up to ${provider.batchLimit}`,
  );

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

    console.log(
      `[rag:embeddings] batch ${batchIdx}/${totalBatches}: ${batch.length} vectors (dim=${out[0]?.length ?? "?"}) in ${Math.round(performance.now() - tBatch)}ms`,
    );
  }

  console.log(`[rag:embeddings] done in ${Math.round(performance.now() - t0)}ms`);
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
