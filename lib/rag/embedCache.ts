// ---------------------------------------------------------------------------
// Two-layer embedding cache + cosine, shared by everything in the app that pays
// to embed text: INGEST (lib/rag/pipeline, lib/rag/reconfigure, and the batch
// leg in lib/batch/jobs/ingestEmbedding), the per-chunk "try a different model"
// trial (lib/rag/eval.runModelTrial), the graded-nDCG ranking builder
// (lib/rag/ranking.ts), and delegate-space retrieval (lib/rag/retriever).
//
// INGEST GOES THROUGH HERE, and that is the point of the table rather than an
// afterthought. A chunk's vector used to live only in chunks_<model>_<dim>,
// which hangs off the document — so deleting a document destroyed the only copy
// and re-uploading it bought the same bytes again. embedding_cache has no
// foreign key to `documents`; its lifetime is the USER's. Banking ingest here
// means a deleted-then-re-uploaded document is free, and so is the same document
// ingested into a second config even when no run survives anywhere.
//
// L1 is the original in-process Map (dies with the server). L2 is the
// embedding_cache table (migration 0020): content-addressed by
// (model, input_kind, sha256(text)) — no raw text stored — so any string ever
// embedded under a model costs one provider API call across restarts, trials,
// and queries. Misses embed via the provider and write back to both layers.
// L2 is best-effort: if migration 0020 hasn't been applied (undefined_table,
// 42P01) the cache degrades to the old memory-only behavior.
//
// TWO COSTS THAT COME WITH INGEST BEING HERE, both accepted knowingly. A chunk's
// vector now lives twice — in chunks_<model>_<dim> for retrieval and here for
// reuse, ~4KB each — and that cannot be collapsed by sharing rows, because the
// two tables have different lifetimes on purpose, which is the whole point. And
// L1 below is a process-global Map that is never evicted, so a 10,000-chunk
// corpus is ~80MB resident until restart. Fine at current scale; if the server's
// memory ever becomes the constraint, the dials are an LRU bound or an ingest
// path that writes L2 and skips L1 (ingest never re-reads what it just embedded).
//
// BOTH LAYERS ARE PER-USER as of 0050. The table was global and content-
// addressed, which under strict BYOK is a cost transfer (one account's key pays
// to bank a vector another reads for free) and leaves a row nobody owns, so
// "delete my account" can't reach it. L1 carries activeUserId() in its key for
// the same reason — a process-global Map would hand back exactly the vectors the
// table change just partitioned, and reopen the same existence oracle, for as
// long as the server stays up. The two layers must agree or neither means
// anything.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

import { activeUserId } from "@/lib/auth/userScope";
import { isolated, sql } from "@/lib/db";
import { detached } from "@/lib/detached";
import { embedQuery, embedTexts } from "@/lib/rag/embeddings";
import { costEmbed, estimateTokens, estimateTokensAll } from "@/lib/rag/pricing";
import { recordSaving, recordSpend } from "@/lib/rag/savingsStore";

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// USD to embed these texts under `model` (char/4 token estimate). One place so
// the cache-hit saving and the miss spend price identically.
const embedCost = (model: string, texts: string[]): number =>
  texts.reduce((sum, t) => sum + costEmbed(model, estimateTokens(t)), 0);

// A cache HIT is an avoided embed — bank it as an embed_cache saving. A MISS
// paid the provider — bank it as embed spend. Both are one upsert for the whole
// batch (recordSaving/Spend add aggregates), and both go through detached().
//
// Async, and every caller must await it. It used to be synchronous-by-void,
// which is exactly the bug lib/detached.ts exists to prevent — the awaits are
// free inside a request (the work is queued for after the response) and the type
// checker is what keeps the nine call sites honest, since a `void`-grep can't.
//
// Exported because two paid embed paths cache OUTSIDE this module and would
// otherwise go unpriced against the no-cache counterfactual: the eval
// query-vector cache (eval_question_embeddings, keyed by question id — see
// eval.scoreQuestions) and live chat retrieval (retriever.retrieve, which has
// no cache at all, so it only ever reports spend). They own their storage; this
// owns what an embed costs.
export async function meterEmbeds(
  model: string,
  hits: string[],
  misses: string[],
): Promise<void> {
  if (hits.length > 0) {
    await detached(() =>
      recordSaving("embed_cache", embedCost(model, hits), estimateTokensAll(hits), {
        events: hits.length,
      }),
    );
  }
  if (misses.length > 0) {
    await detached(() =>
      recordSpend("embed", embedCost(model, misses), estimateTokensAll(misses)),
    );
  }
}

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
// Mirrors the L2 primary key (user_id, model, input_kind, text_hash), user first.
// activeUserId() throws outside a request scope, which is the desired failure:
// an unscoped caller would otherwise share one tenant's vectors with the next.
const memKey = (model: string, kind: InputKind, text: string) =>
  `${activeUserId()} ${model} ${kind} ${text}`;

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
      where user_id = ${activeUserId()}
        and model = ${model} and input_kind = ${kind}
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

// One statement per this many rows. A row carries the vector — 1,024 floats —
// so a few hundred is already a multi-megabyte statement.
const WRITE_BATCH = 200;

// L2 write-back for freshly embedded texts. `on conflict do nothing`: a
// concurrent request may have raced us to the same (deterministic) vector.
// Since 0050 that conflict is only ever with THIS user's own row — two accounts
// embedding the same text now bank a row each, which is the dedup we gave up.
//
// BATCHED, because ingest writes here now. A savepoint plus an insert per text —
// two round trips each — was survivable while the callers were trials and
// rankings writing handfuls. A document's whole chunk set, and a corpus sync's
// every document, is not: a 5,000-chunk sync would be ~10,000 round trips
// against a connection held for the length of the request (lib/db.ts).
//
// BEST-EFFORT, for the same reason. This used to rethrow anything that wasn't a
// missing table, and with ingest depending on it that would fail the INGEST —
// vectors bought, run lost — over a write whose only cost when it's missing is
// one future embed. So it warns and carries on, like every other
// telemetry-adjacent write in the store layer. NOT symmetric with the read:
// readPersisted must still throw, because silently treating every text as a miss
// is a silent bill.
async function writePersisted(
  model: string,
  kind: InputKind,
  entries: { text: string; vector: number[] }[],
): Promise<void> {
  const userId = activeUserId();
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    const rows = entries.slice(i, i + WRITE_BATCH).map(({ text, vector }) => ({
      user_id: userId,
      model,
      input_kind: kind,
      text_hash: hashText(text),
      dimension: vector.length,
      embedding: vector,
    }));
    try {
      await isolated(
        () => sql`
          insert into embedding_cache ${sql(
            rows,
            "user_id",
            "model",
            "input_kind",
            "text_hash",
            "dimension",
            "embedding",
          )}
          on conflict do nothing
        `,
      );
    } catch (err) {
      // Missing table (0020 unapplied) is the documented degradation and stays
      // silent; anything else is worth seeing. Either way this abandons the
      // REMAINING batches too — whatever stopped one will stop the next — and
      // returns normally, so the caller's embed still succeeds.
      if (!isMissingTable(err)) {
        console.warn(`[rag:embedCache] cache write failed: ${(err as Error).message}`);
      }
      return;
    }
  }
}

// Embed `texts` as documents under `model`, returning vectors in input order.
// L1 hit → free; L2 hit → one batched point-read; only never-seen texts hit the
// provider API (de-duplicated), and those are banked in both layers.
export async function embedDocsCached(
  texts: string[],
  model: string,
): Promise<number[][]> {
  const unique = uniq(texts);
  const l1hits = unique.filter((t) => memory.has(memKey(model, "document", t)));
  const notInMemory = unique.filter((t) => !memory.has(memKey(model, "document", t)));
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
  await meterEmbeds(model, [...l1hits, ...persisted.keys()], missing);
  return texts.map((t) => memory.get(memKey(model, "document", t))!);
}

// Bank vectors this process did NOT embed itself — the async batch ingest, whose
// vectors arrive from a provider's batch API hours after they were asked for
// (lib/batch/jobs/ingestEmbedding.apply). Without this, batch-ingested documents
// would never populate the cache and deleting one would still cost money to
// re-upload, which would make two ways of doing the same thing behave
// differently for no reason a user could see.
//
// L2 only, deliberately. L1 exists to spare a re-read within a process, and
// nothing re-reads these: apply() writes the run and is done. Filling it would
// only grow a Map that is never evicted (see the header).
//
// Meters nothing: the batch leg prices its own embeds (lib/batch/savings.ts).
export async function bankDocVectors(
  entries: { text: string; vector: number[] }[],
  model: string,
): Promise<void> {
  if (entries.length === 0) return;
  await writePersisted(model, "document", entries);
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
  // NOT metered as a saving. A hit here avoids nothing: the no-cache
  // counterfactual for a cache-only reader is "skip the chunk" (retriever drops
  // an unfound text from the pool), not "pay to embed it". Banking here would
  // also re-credit the SAME vector on every read of a hot path, inflating
  // embed_cache without bound. The paid paths (embedDocsCached /
  // embedQueryCached) are where a real avoided embed is counted.
  return out;
}

// Cache-only lookup for QUERY strings — the query-kind counterpart of
// cachedDocVectors: vectors for whichever of `texts` are already banked under
// `model`, never calling the provider. Backs the post-autotune dirty screen
// (eval.rescoreAffectedQuestions), where a miss just means "can't prove clean,
// re-score" — the re-score embeds (and banks) it anyway.
export async function cachedQueryVectors(
  texts: string[],
  model: string,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const misses: string[] = [];
  for (const t of uniq(texts)) {
    const vec = memory.get(memKey(model, "query", t));
    if (vec) out.set(t, vec);
    else misses.push(t);
  }
  const persisted = await readPersisted(model, "query", misses);
  for (const [t, vec] of persisted) {
    memory.set(memKey(model, "query", t), vec);
    out.set(t, vec);
  }
  // NOT metered as a saving (see cachedDocVectors): a miss here just marks the
  // question dirty for re-scoring, which embeds it on the paid path and meters
  // it there — so a hit avoided nothing that would otherwise have been bought.
  return out;
}

// Embed one query string under `model`, cached through both layers.
export async function embedQueryCached(text: string, model: string): Promise<number[]> {
  const key = memKey(model, "query", text);
  let vec = memory.get(key);
  if (vec) {
    await meterEmbeds(model, [text], []);
    return vec;
  }

  const persisted = await readPersisted(model, "query", [text]);
  vec = persisted.get(text);
  if (!vec) {
    vec = await embedQuery(text, model);
    await writePersisted(model, "query", [{ text, vector: vec }]);
    await meterEmbeds(model, [], [text]);
  } else {
    await meterEmbeds(model, [text], []);
  }
  memory.set(key, vec);
  return vec;
}
