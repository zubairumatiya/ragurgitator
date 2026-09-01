// Two-layer embedding cache + cosine, shared by everything in the app that pays to
// embed text: ingest, the per-chunk "try a different model" trial, the graded-nDCG
// ranking builder, and delegate-space retrieval.
//
// INGEST GOES THROUGH HERE, and that is the point of the table. A chunk's vector
// used to live only in chunks_<model>_<dim>, which hangs off the document — so
// deleting a document destroyed the only copy and re-uploading it bought the same
// bytes again. embedding_cache has no foreign key to `documents`; its lifetime is
// the USER's. So a deleted-then-re-uploaded document is free, and so is the same
// document ingested into a second config.
//
// L1 is an in-process Map (dies with the server). L2 is the embedding_cache table
// (0020), content-addressed by (model, input_kind, sha256(text)) — no raw text
// stored — so any string ever embedded under a model costs one provider call
// across restarts, trials and queries. L2 is best-effort: without 0020 the cache
// degrades to memory-only.
//
// TWO COSTS, both accepted knowingly. A chunk's vector now lives twice — in
// chunks_<model>_<dim> for retrieval and here for reuse, ~4KB each — which cannot
// be collapsed by sharing rows, because the two tables have different lifetimes on
// purpose. And L1 is never evicted, so a 10,000-chunk corpus is ~80MB resident
// until restart; the dials if that ever binds are an LRU bound or an ingest path
// that writes L2 and skips L1.
//
// BOTH LAYERS ARE PER-USER as of 0050. The table was global and content-addressed,
// which under strict BYOK is a cost transfer (one account's key pays to bank a
// vector another reads for free) and leaves a row nobody owns, so "delete my
// account" can't reach it. L1 carries activeUserId() in its key for the same
// reason — the two layers must agree or neither means anything.
import { createHash } from "node:crypto";

import { activeUserId } from "@/lib/auth/userScope";
import { isolated, sql } from "@/lib/db";
import { detached } from "@/lib/detached";
import { embedQueries, embedQuery, embedTexts } from "@/lib/rag/embeddings";
import {
  costEmbed,
  estimateTokens,
  estimateTokensAll,
  estimateTokensFromChars,
} from "@/lib/rag/pricing";
import { recordSaving, recordSpend } from "@/lib/rag/savingsStore";

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// USD to embed these texts under `model` (char/4 token estimate). One place so
// the cache-hit saving and the miss spend price identically.
const embedCost = (model: string, texts: string[]): number =>
  texts.reduce((sum, t) => sum + costEmbed(model, estimateTokens(t)), 0);

// A cache HIT is an avoided embed — bank it as an embed_cache saving. A MISS paid
// the provider — bank it as embed spend. Both are one upsert for the whole batch,
// and both go through detached().
//
// Async, and every caller must await it. It used to be synchronous-by-void, which
// is exactly the bug lib/detached.ts exists to prevent — the awaits are free inside
// a request (the work is queued for after the response) and the type checker is
// what keeps the nine call sites honest, since a `void`-grep can't.
//
// Exported because two paid embed paths cache OUTSIDE this module and would
// otherwise go unpriced: the eval query-vector cache and live chat retrieval
// (which has no cache at all, so it only ever reports spend). They own their
// storage; this owns what an embed costs.
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

// The same avoided-embed saving as meterEmbeds' hit half, for a caller that
// holds CHARACTER COUNTS rather than the texts — the fusion pool's competitor
// sims are computed in Postgres now (vectorStore.poolDocSims), so the hit is
// real but the text was deliberately never downloaded to price it.
//
// Not folded into meterEmbeds: that function's contract is "these exact strings
// hit, these exact strings missed", and a char-count caller can never report a
// miss (a miss there is bought on the ordinary path and metered there).
//
// The estimate drifts from the text-based one only for astral characters, where
// Postgres' char_length counts one and JS's .length counts two. Same tradeoff
// the re-ingest skip already accepted (pricing.estimateTokensFromChars).
export async function meterEmbedHitsByChars(
  model: string,
  charCounts: number[],
): Promise<void> {
  if (charCounts.length === 0) return;
  let usd = 0;
  let tokens = 0;
  for (const chars of charCounts) {
    const t = estimateTokensFromChars(chars);
    tokens += t;
    usd += costEmbed(model, t);
  }
  await detached(() =>
    recordSaving("embed_cache", usd, tokens, { events: charCounts.length }),
  );
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

// The optional on-disk layer (lib/rag/embedDiskCache.ts) sits between L1 and L2,
// and ONLY when EMBED_DISK_CACHE names a directory. Imported dynamically for two
// reasons: a deployment then never loads a module that touches node:fs, and the
// feature costs an unconfigured process nothing but this one env read.
//
// Cached rather than re-imported per call — this is on the ingest path, which
// calls readPersisted in a loop.
type DiskCache = typeof import("@/lib/rag/embedDiskCache");
let diskModule: Promise<DiskCache> | null = null;
const disk = (): Promise<DiskCache> | null => {
  if (!process.env.EMBED_DISK_CACHE) return null;
  diskModule ??= import("@/lib/rag/embedDiskCache");
  return diskModule;
};

// Batched L2 read: vectors for the given texts that are already persisted,
// keyed back by text. Missing-table → empty (memory-only degradation).
//
// With the disk layer enabled the order is disk → database → write the database's
// answers back to disk, so a repeat run of the same sweep reads nothing over the
// network. The database remains the source of truth: disk can only ever ANSWER a
// hash, never assert that one is absent.
async function readPersisted(
  model: string,
  kind: InputKind,
  texts: string[],
): Promise<Map<string, number[]>> {
  if (texts.length === 0) return new Map();
  const userId = activeUserId();
  const hashes = texts.map(hashText);
  const out = new Map<string, number[]>();

  const diskCache = disk();
  const fromDisk = diskCache
    ? (await diskCache).readDisk(userId, model, kind, hashes)
    : new Map<string, number[]>();

  const wanted: string[] = [];
  texts.forEach((t, i) => {
    const vec = fromDisk.get(hashes[i]);
    if (vec) out.set(t, vec);
    else wanted.push(hashes[i]);
  });
  if (wanted.length === 0) return out;

  try {
    const rows = await sql<{ text_hash: string; embedding: number[] }[]>`
      select text_hash, embedding
      from embedding_cache
      where user_id = ${userId}
        and model = ${model} and input_kind = ${kind}
        and text_hash = any(${wanted})
    `;
    const byHash = new Map(rows.map((r) => [r.text_hash, r.embedding]));
    texts.forEach((t, i) => {
      const vec = byHash.get(hashes[i]);
      if (vec) out.set(t, vec);
    });
    if (diskCache && rows.length > 0) {
      (await diskCache).appendDisk(
        userId,
        model,
        kind,
        rows.map((r) => ({ hash: r.text_hash, vector: r.embedding })),
      );
    }
    return out;
  } catch (err) {
    // A missing table degrades to whatever disk already had, which is nothing
    // when the layer is off — the pre-existing memory-only behaviour.
    if (isMissingTable(err)) return out;
    throw err;
  }
}

// One statement per this many rows. A row carries the vector — 1,024 floats —
// so a few hundred is already a multi-megabyte statement.
const WRITE_BATCH = 200;

// L2 write-back for freshly embedded texts. `on conflict do nothing`: a concurrent
// request may have raced us to the same deterministic vector. Since 0050 that
// conflict is only ever with THIS user's own row.
//
// BATCHED, because ingest writes here now. A savepoint plus an insert per text —
// two round trips each — was survivable while the callers wrote handfuls; a
// 5,000-chunk sync would be ~10,000 round trips against a connection held for the
// length of the request.
//
// BEST-EFFORT, for the same reason. This used to rethrow anything that wasn't a
// missing table, which with ingest depending on it would fail the INGEST — vectors
// bought, run lost — over a write whose only cost when missing is one future embed.
// NOT symmetric with the read: readPersisted must still throw, because silently
// treating every text as a miss is a silent bill.
async function writePersisted(
  model: string,
  kind: InputKind,
  entries: { text: string; vector: number[] }[],
): Promise<void> {
  const userId = activeUserId();
  // A freshly bought vector goes to disk too, when the layer is on. Without this
  // the first run after an embed still pays to read back what it just wrote.
  const diskCache = disk();
  if (diskCache) {
    (await diskCache).appendDisk(
      userId,
      model,
      kind,
      entries.map(({ text, vector }) => ({ hash: hashText(text), vector })),
    );
  }
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
// vectors arrive hours after they were asked for. Without this, batch-ingested
// documents would never populate the cache and deleting one would still cost money
// to re-upload, making two ways of doing the same thing behave differently.
//
// L2 only, deliberately. L1 exists to spare a re-read within a process, and nothing
// re-reads these: apply() writes the run and is done.
//
// Meters nothing: the batch leg prices its own embeds.
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

// Disk-layer-only lookup, BY HASH — the one piece of readPersisted a caller can
// still use once it has stopped carrying text. Returns hash → vector for whatever
// the optional on-disk layer already holds, and an empty map when EMBED_DISK_CACHE
// is unset (the default), which makes it a no-op rather than a second code path.
//
// Exists because the fusion pool's free-competitor lookup moved into SQL
// (vectorStore.poolDocSims, docs/demo-egress-plan.md §1.2). That join asks the
// DATABASE, so without this the precedence would silently become database-only and
// turning the disk cache on would stop answering candidates it used to answer.
// Order is preserved as disk → the join → pay.
export async function diskDocVectorsByHash(
  model: string,
  hashes: string[],
): Promise<Map<string, number[]>> {
  if (hashes.length === 0) return new Map();
  const diskCache = disk();
  if (!diskCache) return new Map();
  return (await diskCache).readDisk(activeUserId(), model, "document", hashes);
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

// Embed MANY query strings under `model`, cached through both layers — the
// query-role twin of embedDocsCached, and the bulk form of embedQueryCached.
//
// WHY IT EXISTS. embedQueryCached is one text per call: one `readPersisted`
// round trip, one provider call on a miss, one `writePersisted`, one metering
// write. A caller with 300 texts (the key-model sweep) therefore pays 300 of
// each — and since every store call inside a request scope shares ONE
// transaction on ONE connection (lib/db.ts), those round trips are strictly
// sequential no matter how much concurrency the caller wraps around them. That
// is the actual cost of a warm sweep: not the provider, the round trips.
//
// This collapses them: one read for the whole set, one batched embed of just the
// misses (chunked by the provider's own cap inside embedQueries), one write, one
// metering call. Same cost math and the same `embed_cache` lever as the per-text
// path — the saving is priced off the hit list either way, just banked once
// instead of per text.
export async function embedQueriesCached(
  texts: string[],
  model: string,
): Promise<Map<string, number[]>> {
  const unique = uniq(texts);
  const l1hits = unique.filter((t) => memory.has(memKey(model, "query", t)));
  const notInMemory = unique.filter((t) => !memory.has(memKey(model, "query", t)));
  const persisted = await readPersisted(model, "query", notInMemory);
  for (const [t, vec] of persisted) memory.set(memKey(model, "query", t), vec);

  const missing = notInMemory.filter((t) => !persisted.has(t));
  if (missing.length > 0) {
    const vecs = await embedQueries(missing, model);
    missing.forEach((t, i) => memory.set(memKey(model, "query", t), vecs[i]));
    await writePersisted(
      model,
      "query",
      missing.map((t, i) => ({ text: t, vector: vecs[i] })),
    );
  }
  await meterEmbeds(model, [...l1hits, ...persisted.keys()], missing);
  return new Map(unique.map((t) => [t, memory.get(memKey(model, "query", t))!]));
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
