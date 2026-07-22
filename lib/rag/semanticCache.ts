// ---------------------------------------------------------------------------
// SEMANTIC CACHE — orchestration (DB-facing). Serves a PAST answer for a NEW
// question when the two are close enough in embedding space, letting ask()
// skip retrieval (and, once it's enabled, generation) entirely. See
// docs/semantic-caching-plan.md. The correctness decisions live in the
// dependency-free core (semanticCacheCore.ts); this file is the plumbing:
// embed the query, find the nearest cached entry valid for today's config,
// and decide via the per-space threshold whether it's a hit.
//
// Best-effort, exactly like embedCache: if migration 0031 isn't applied
// (undefined_table, 42P01) lookups always miss and stores are no-ops, so the
// feature is safe to ship ahead of the migration.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";

import { config } from "@/lib/config";
import { sql } from "@/lib/db";
import { activeConfig, type ResolvedConfig } from "@/lib/rag/activeConfig";
import { embedQueryCached } from "@/lib/rag/embedCache";
import type { EfficacyResult } from "@/lib/rag/efficacyGate";
import { retrievalStateFingerprint } from "@/lib/rag/overrideStore";
import {
  bestMatch,
  fingerprintFrom,
  isHit,
  spaceOf,
  type CacheEntry,
} from "@/lib/rag/semanticCacheCore";
import type { RetrievedChunk } from "@/types/rag";

// The full result ask() produces and the cache banks verbatim ("the cache stores
// whatever ask() returns"). model / efficacy / escalated come from the generation
// cascade (pipeline.answerWithCascade); efficacy is null when saver mode is off.
export type CachedResult = {
  answer: string;
  sources: RetrievedChunk[];
  model: string;
  efficacy: EfficacyResult | null;
  escalated: boolean;
};

// Lookup always embeds the query and hands the vector back, so a miss can reuse
// it for retrieval (no double-embed) and a subsequent store doesn't re-embed.
export type CacheProbe =
  | { hit: true; result: CachedResult; sim: number; matchedQuery: string; vector: number[] }
  | { hit: false; vector: number[] };

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const truncate = (s: string, n = 80): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

// A signature of the config's corpus CONTENT: which documents are embedded and
// how many chunks they became. Adding/removing a document changes the id set;
// re-chunking (new size/overlap → re-embed) changes the chunk count. Combined
// with the config-shape + override parts below, this makes an entry's
// fingerprint flip whenever the answer it holds could have changed. Missing
// chunk table (fresh config, pre-migration) → a stable "no-corpus" marker.
async function corpusSignature(cfg: ResolvedConfig): Promise<string> {
  try {
    const [row] = await sql<{ docs: string; chunks: number }[]>`
      select
        coalesce(md5(string_agg(distinct document_id::text, ',' order by document_id::text)), 'empty') as docs,
        count(*)::int as chunks
      from ${sql(cfg.chunksTable)}
      where config_id = ${cfg.id}
    `;
    return `${row.docs}:${row.chunks}`;
  } catch (err) {
    if (isMissingTable(err)) return "no-corpus";
    throw err;
  }
}

// The validity key an entry is stored under and looked up by. Everything that
// could change the answer for a question goes in; see semanticCacheCore.
async function currentFingerprint(cfg: ResolvedConfig): Promise<string> {
  const [overrides, corpus] = await Promise.all([
    retrievalStateFingerprint(),
    corpusSignature(cfg),
  ]);
  return fingerprintFrom([
    "sc-v1", // bump to invalidate every entry if the cached shape changes
    cfg.embeddingModel,
    cfg.chunkSize,
    cfg.chunkOverlap,
    cfg.topK,
    cfg.fusionPool, // null (auto) encoded distinctly by fingerprintFrom
    cfg.llmModel,
    overrides,
    corpus,
  ]);
}

// The cosine threshold governing hits for this model's vector-space: a
// calibrated value if one exists (semantic_cache_thresholds), else the
// conservative default. Missing table → default.
async function resolveThreshold(model: string): Promise<number> {
  const space = spaceOf(model);
  try {
    const [row] = await sql<{ threshold: number }[]>`
      select threshold from semantic_cache_thresholds where space = ${space}
    `;
    if (row) return Number(row.threshold);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return config.semanticCache.defaultThreshold;
}

// Find a cached answer for `question`. Embeds the query (cached in 0020) and,
// among entries valid for the current fingerprint and same embedding model,
// finds the nearest one. A match that clears the per-space threshold is only
// RETURNED AS A HIT when `serve` is true (the Settings → Savings toggle); with
// serving off it's logged as a "would-hit" shadow and reported as a miss, so
// the caller recomputes a fresh answer. Either way the query vector is returned
// so the caller can retrieve without re-embedding.
export async function semanticCacheLookup(
  question: string,
  serve: boolean,
): Promise<CacheProbe> {
  const cfg = activeConfig();
  // Embed first: retrieval needs this vector regardless, so a provider error
  // here surfaces exactly as it would without the cache.
  const vector = await embedQueryCached(question, cfg.embeddingModel);

  try {
    const fingerprint = await currentFingerprint(cfg);
    const rows = await sql<
      { query_text: string; query_vector: number[]; result: CachedResult }[]
    >`
      select query_text, query_vector, result
      from semantic_cache
      where config_id = ${cfg.id}
        and embedding_model = ${cfg.embeddingModel}
        and fingerprint = ${fingerprint}
      order by created_at desc
      limit ${config.semanticCache.maxCandidates}
    `;
    if (rows.length === 0) return { hit: false, vector };

    const entries: CacheEntry<{ text: string; result: CachedResult }>[] = rows.map(
      (r) => ({ vector: r.query_vector, value: { text: r.query_text, result: r.result } }),
    );
    const match = bestMatch(vector, entries);
    const threshold = await resolveThreshold(cfg.embeddingModel);

    if (match && isHit(match.sim, threshold)) {
      if (serve) {
        console.log(
          `[rag:semantic-cache] HIT sim=${match.sim.toFixed(4)} ≥ ${threshold} — ` +
            `served cached answer, skipped retrieval. new="${truncate(question)}" ` +
            `matched="${truncate(match.value.text)}"`,
        );
        // Fire-and-forget telemetry bump; a failure here must not fail the answer.
        void bumpHit(cfg.id, cfg.embeddingModel, fingerprint, match.value.text);
        return { hit: true, result: match.value.result, sim: match.sim, matchedQuery: match.value.text, vector };
      }
      // Serving is off (Settings → Savings): shadow-log the would-be hit for
      // threshold validation, then report a miss so a fresh answer is computed.
      console.log(
        `[rag:semantic-cache] would-hit sim=${match.sim.toFixed(4)} ≥ ${threshold} but ` +
          `serving is OFF — recomputing. new="${truncate(question)}" matched="${truncate(match.value.text)}"`,
      );
      return { hit: false, vector };
    }

    if (match) {
      console.log(
        `[rag:semantic-cache] miss (nearest sim=${match.sim.toFixed(4)} < ${threshold}) for "${truncate(question)}"`,
      );
    }
    return { hit: false, vector };
  } catch (err) {
    if (isMissingTable(err)) return { hit: false, vector };
    throw err;
  }
}

// Bank a freshly-computed answer, and opportunistically GC entries whose
// fingerprint no longer matches the config (invalidated by a corpus/config/
// override change). Exact-duplicate questions are suppressed by the unique
// (config, model, fingerprint, query_hash) constraint. Best-effort throughout.
export async function semanticCacheStore(
  question: string,
  vector: number[],
  result: CachedResult,
): Promise<void> {
  const cfg = activeConfig();
  try {
    const fingerprint = await currentFingerprint(cfg);
    await sql`
      insert into semantic_cache
        (config_id, embedding_model, fingerprint, query_text, query_hash, query_vector, dimension, result)
      values
        (${cfg.id}, ${cfg.embeddingModel}, ${fingerprint}, ${question}, ${sha256(question)},
         ${vector}::real[], ${vector.length}, ${JSON.stringify(result)}::jsonb)
      on conflict (config_id, embedding_model, fingerprint, query_hash) do nothing
    `;
    // Self-prune: drop this config's entries left stale by a shape/corpus change.
    await sql`
      delete from semantic_cache
      where config_id = ${cfg.id} and fingerprint <> ${fingerprint}
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    throw err;
  }
}

async function bumpHit(
  configId: string,
  model: string,
  fingerprint: string,
  matchedQuery: string,
): Promise<void> {
  try {
    await sql`
      update semantic_cache
      set hit_count = hit_count + 1, last_hit_at = now()
      where config_id = ${configId} and embedding_model = ${model}
        and fingerprint = ${fingerprint} and query_hash = ${sha256(matchedQuery)}
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    // Telemetry only — swallow so a bump failure never breaks a served answer.
    console.warn(`[rag:semantic-cache] hit-count bump failed: ${(err as Error).message}`);
  }
}
