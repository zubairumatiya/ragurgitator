// ---------------------------------------------------------------------------
// STEP 3 of ingestion (and also used at query time): EMBED
//
// Turns text into a vector (number[]) via the embedding model. The SAME model
// embeds documents at ingest time and the user's question at query time, or
// similarity search is meaningless — that's why both paths read config.
//
// Voyage returns unit-length vectors, so downstream cosine similarity reduces
// to a plain dot product (see vectorStore.ts).
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { voyageClient } from "@/lib/llm/client";

// A single embed call accepts at most 128 inputs, so longer lists are split
// across requests. With 512-token chunks this stays well under the token cap.
const MAX_BATCH = 128;

// `document` and `query` nudge the vectors so questions align with the answers
// that satisfy them — same model, just a hint about each text's role.
//
// `model` defaults to the active config model (the only one used at ingest/query
// time). The per-chunk "try a different model" experiment passes an alternate
// model to embed an ad-hoc candidate pool + queries for in-memory re-ranking —
// never the live index (see lib/rag/eval.runModelTrial).
async function embed(
  texts: string[],
  inputType: "document" | "query",
  model: string = config.embeddingModel,
): Promise<number[][]> {
  const t0 = performance.now();
  const totalBatches = Math.ceil(texts.length / MAX_BATCH);
  console.log(
    `[rag:embeddings] embedding ${texts.length} ${inputType}(s) with ${model} in ${totalBatches} batch(es) of up to ${MAX_BATCH}`,
  );

  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += MAX_BATCH) {
    const batch = texts.slice(start, start + MAX_BATCH);
    const batchIdx = start / MAX_BATCH + 1;
    const tBatch = performance.now();
    const response = await voyageClient.embed({
      input: batch,
      model,
      inputType,
    });

    const data = response.data;
    if (!data || data.length !== batch.length) {
      throw new Error(
        `Voyage returned ${data?.length ?? 0} embeddings for ${batch.length} inputs`,
      );
    }

    // `index` maps each embedding back to its input slot; sort so vectors line
    // up with `texts` regardless of the order the API responds in.
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of data) {
      if (!item.embedding) throw new Error("Voyage returned an empty embedding");
      vectors.push(item.embedding);
    }
    console.log(
      `[rag:embeddings] batch ${batchIdx}/${totalBatches}: ${batch.length} vectors (dim=${data[0]?.embedding?.length ?? "?"}) in ${Math.round(performance.now() - tBatch)}ms`,
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
