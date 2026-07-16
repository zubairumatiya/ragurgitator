// ---------------------------------------------------------------------------
// Two-layer embedding cache + cosine, shared by everything that embeds text
// under a model other than a config's base ANN table: the per-chunk "try a
// different model" trial (lib/rag/eval.runModelTrial), the graded-nDCG ranking
// builder (lib/rag/ranking.ts), and delegate-space retrieval (lib/rag/retriever).
//
// L1 is the original in-process Map (dies with the server). L2 is the global
// embedding_cache table (migration 0020): content-addressed by
// (model, input_kind, sha256(text)) — no raw text stored — so any string ever
// embedded under a model costs one provider API call across restarts, trials,
// and queries. Misses embed via the provider and write back to both layers.
// L2 is best-effort: if migration 0020 hasn't been applied (undefined_table,
// 42P01) the cache degrades to the old memory-only behavior.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

import { sql } from "@/lib/db";
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

type InputKind = "document" | "query";

const memory = new Map<string, number[]>();
const memKey = (model: string, kind: InputKind, text: string) =>
  `${model} ${kind} ${text}`;

// Must match the backfill script and any SQL-side hashing:
// encode(sha256(text::bytea), 'hex') over the exact input string (UTF-8).
const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// Batched L2 read: vectors for the given texts that are already persisted,
// keyed back by text. Missing-table → empty (memory-only degradation).
async function readPersisted(
  model: string,
  kind: InputKind,
  texts: string[],
): Promise<Map<string, number[]>> {
  if (texts.length === 0) return new Map();
  const hashes = texts.map(hashText);
  try {
    const rows = await sql<{ text_hash: string; embedding: number[] }[]>`
      select text_hash, embedding
      from embedding_cache
      where model = ${model} and input_kind = ${kind}
        and text_hash = any(${hashes})
    `;
    const byHash = new Map(rows.map((r) => [r.text_hash, r.embedding]));
    const out = new Map<string, number[]>();
    texts.forEach((t, i) => {
      const vec = byHash.get(hashes[i]);
      if (vec) out.set(t, vec);
    });
    return out;
  } catch (err) {
    if (isMissingTable(err)) return new Map();
    throw err;
  }
}

// L2 write-back for freshly embedded texts. `on conflict do nothing`: a
// concurrent request may have raced us to the same (deterministic) vector.
async function writePersisted(
  model: string,
  kind: InputKind,
  entries: { text: string; vector: number[] }[],
): Promise<void> {
  try {
    for (const { text, vector } of entries) {
      await sql`
        insert into embedding_cache (model, input_kind, text_hash, dimension, embedding)
        values (${model}, ${kind}, ${hashText(text)}, ${vector.length}, ${vector}::real[])
        on conflict do nothing
      `;
    }
  } catch (err) {
    if (isMissingTable(err)) return;
    throw err;
  }
}

// Embed `texts` as documents under `model`, returning vectors in input order.
// L1 hit → free; L2 hit → one batched point-read; only never-seen texts hit the
// provider API (de-duplicated), and those are banked in both layers.
export async function embedDocsCached(
  texts: string[],
  model: string,
): Promise<number[][]> {
  const notInMemory = uniq(
    texts.filter((t) => !memory.has(memKey(model, "document", t))),
  );
  const persisted = await readPersisted(model, "document", notInMemory);
  for (const [t, vec] of persisted) memory.set(memKey(model, "document", t), vec);

  const missing = notInMemory.filter((t) => !persisted.has(t));
  if (missing.length > 0) {
    const vecs = await embedTexts(missing, model);
    missing.forEach((t, i) => memory.set(memKey(model, "document", t), vecs[i]));
    await writePersisted(
      model,
      "document",
      missing.map((t, i) => ({ text: t, vector: vecs[i] })),
    );
  }
  return texts.map((t) => memory.get(memKey(model, "document", t))!);
}

// Cache-only lookup: vectors for whichever of `texts` are already known under
// `model` (either layer) — NEVER calls the provider. L2 hits are promoted to
// L1. Backs the free-competitor extension of the fusion pool (retriever):
// texts beyond the paid pool join the ranking only if they're already banked.
export async function cachedDocVectors(
  texts: string[],
  model: string,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const misses: string[] = [];
  for (const t of uniq(texts)) {
    const vec = memory.get(memKey(model, "document", t));
    if (vec) out.set(t, vec);
    else misses.push(t);
  }
  const persisted = await readPersisted(model, "document", misses);
  for (const [t, vec] of persisted) {
    memory.set(memKey(model, "document", t), vec);
    out.set(t, vec);
  }
  return out;
}

// Embed one query string under `model`, cached through both layers.
export async function embedQueryCached(text: string, model: string): Promise<number[]> {
  const key = memKey(model, "query", text);
  let vec = memory.get(key);
  if (vec) return vec;

  const persisted = await readPersisted(model, "query", [text]);
  vec = persisted.get(text);
  if (!vec) {
    vec = await embedQuery(text, model);
    await writePersisted(model, "query", [{ text, vector: vec }]);
  }
  memory.set(key, vec);
  return vec;
}
