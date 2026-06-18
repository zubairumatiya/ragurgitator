// ---------------------------------------------------------------------------
// Session-scoped embedding cache + cosine, shared by the in-memory re-ranking
// experiments that re-embed a small pool under alternate models WITHOUT touching
// the chunks_<model>_<dim> tables: the per-chunk "try a different model" trial
// (lib/rag/eval.runModelTrial) and the graded-nDCG ranking builder
// (lib/rag/ranking.ts).
//
// Keyed by (model, role, text), so the same pool chunk or question embedded
// again — a repeat run, a "Save" re-run, an aggregate that reuses the baseline
// model — is effectively free. In-memory only: it dies with the server process
// and never persists.
// ---------------------------------------------------------------------------
import { embedQuery, embedTexts } from "@/lib/rag/embeddings";

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// Cosine similarity. Voyage vectors are already unit-length (so this reduces to
// a dot product), but normalize defensively so a non-unit vector can't skew a
// ranking. Pool + query are always the SAME model here, so dimensions match.
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const cache = new Map<string, number[]>();
const cacheKey = (model: string, role: "document" | "query", text: string) =>
  `${model} ${role} ${text}`;

// Embed `texts` as documents under `model`, returning vectors in input order.
// Only uncached, de-duplicated texts hit the API.
export async function embedDocsCached(
  texts: string[],
  model: string,
): Promise<number[][]> {
  const missing = uniq(texts.filter((t) => !cache.has(cacheKey(model, "document", t))));
  if (missing.length > 0) {
    const vecs = await embedTexts(missing, model);
    missing.forEach((t, i) => cache.set(cacheKey(model, "document", t), vecs[i]));
  }
  return texts.map((t) => cache.get(cacheKey(model, "document", t))!);
}

// Embed one query string under `model`, cached.
export async function embedQueryCached(text: string, model: string): Promise<number[]> {
  const key = cacheKey(model, "query", text);
  let vec = cache.get(key);
  if (!vec) {
    vec = await embedQuery(text, model);
    cache.set(key, vec);
  }
  return vec;
}
