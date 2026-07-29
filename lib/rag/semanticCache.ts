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
import { getBatchSavings } from "@/lib/rag/batchStore";
import { getConfig } from "@/lib/rag/configStore";
import { embedQueryCached } from "@/lib/rag/embedCache";
import { EMBEDDING_MODELS } from "@/lib/rag/embeddingModels";
import type { EfficacyResult } from "@/lib/rag/efficacyGate";
import { retrievalStateFingerprint } from "@/lib/rag/overrideStore";
import { costLlm, estimateTokens, estimateTokensAll } from "@/lib/rag/pricing";
import { recordSaving } from "@/lib/rag/savingsStore";
import {
  bestMatch,
  entityGuardPasses,
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

// What a lookup embedded the question under: the resolved CACHE-KEY model and
// the resulting vector. Handed back on a miss so the subsequent store banks the
// same vector under the same model without re-embedding.
export type CacheKey = { model: string; vector: number[] };

// A miss also hands back the RETRIEVAL query vector when the lookup happens to
// already have it — i.e. when the cache-key model and the config's embedding
// model coincide, which is the default. Decoupled, they're vectors in different
// spaces and the key vector is useless to the retriever, so `queryVector` is
// null and the caller embeds for retrieval itself.
//
// A hit carries neither: it skips retrieval AND generation, so there is nothing
// left to reuse a vector for.
export type CacheProbe =
  | { hit: true; result: CachedResult; sim: number; matchedQuery: string }
  | { hit: false; key: CacheKey; queryVector: number[] | null };

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
  // NOTE: the CACHE-KEY model is deliberately absent here. The fingerprint is
  // the ANSWER-VALIDITY key — the retrieval model belongs in it because it
  // changes what answer was produced. The key model changes only how questions
  // are indexed for lookup, and it already has a column of its own
  // (semantic_cache.embedding_model), so folding it in would needlessly
  // invalidate every cached ANSWER on a key-model switch.
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

// --- the cache-key model ---------------------------------------------------

// The embedding model incoming questions are keyed under for the proximity
// match. Two layers, mirroring resolveThreshold:
//
//   configs.batch_savings.semanticCache.keyModel   (per-config override)
//     ?? config.semanticCache.keyModel             (global default)
//
// This is NOT the config's retrieval model: the cache-key vector never touches
// a chunks_* table, so it needs neither `ingestable` nor a matching dimension —
// every registered model is a candidate. See docs/semantic-cache-key-model-plan.md.
//
// An override naming a model that isn't in the registry falls back to the
// global default rather than throwing: the alternative is a provider error on
// the answer hot path over a stale/hand-edited jsonb value, and the default is
// always a working model.
export function resolveKeyModel(override: string | null): string {
  if (override !== null && EMBEDDING_MODELS[override]) return override;
  if (override !== null) {
    console.warn(
      `[rag:semantic-cache] unknown cache-key model "${override}" — ` +
        `falling back to ${config.semanticCache.keyModel}.`,
    );
  }
  return config.semanticCache.keyModel;
}

// --- the calibration precision target --------------------------------------

// The precision the calibration sweeps hold themselves to. Two layers, same
// shape as resolveKeyModel:
//
//   configs.batch_savings.semanticCache.acceptTarget  (per-config override)
//     ?? config.semanticCache.acceptTarget            (global default, 0.99)
//
// This is a PROBABILITY, not a cosine: it's the rule that derives τ from judged
// evidence, where `threshold` is a hand-set τ. Both sweeps take it as a
// PARAMETER rather than reading it here (see the note on semanticCacheLookup) —
// the pages that host them are not config-scoped, so a target read deep in the
// stack would silently be the Default config's. Resolving at the route and
// passing it down keeps "whose setting is this?" answerable.
export function resolveAcceptTarget(override: number | null): number {
  return override ?? config.semanticCache.acceptTarget;
}

// The target in force plus where it came from, so a sweep can report the number
// it held itself to AND whose setting that was. Needed because /appraise/
// semantic-cache is NOT under /c/<configId>: apiFetch sends no configId there
// (lib/http/client.ts), so the scoped config is the Default one, and a bare
// "precision held at 99%" would hide which config's dial produced it.
export type EffectiveAcceptTarget = {
  target: number;
  source: "config" | "default";
  configId: string;
  configLabel: string;
};

// Resolve the target for the CURRENTLY SCOPED config. Call this at the route
// (inside withRequestConfig) and hand the result to the sweep, so the sweep
// stays a pure function of its inputs and the response can name the owner.
export async function scopedAcceptTarget(): Promise<EffectiveAcceptTarget> {
  const { id } = activeConfig();
  const [savings, cfg] = await Promise.all([getBatchSavings(id), getConfig(id)]);
  const override = savings.semanticCache.acceptTarget;
  return {
    target: resolveAcceptTarget(override),
    source: override === null ? "default" : "config",
    configId: id,
    configLabel: cfg?.label ?? "config",
  };
}

// Where an effective threshold came from — surfaced to the UI so a number is
// never shown without saying which layer set it.
export type ThresholdSource = "config" | "calibrated" | "default";

export type EffectiveThreshold = {
  space: string;
  threshold: number;
  source: ThresholdSource;
};

// The cosine threshold governing hits, INHERITED for this model's vector-space:
// a calibrated value if one exists (semantic_cache_thresholds), else the
// conservative default. Missing table → default. This is what a config with no
// override of its own runs at, and what the Settings input shows as its
// placeholder.
export async function inheritedThreshold(model: string): Promise<EffectiveThreshold> {
  const space = spaceOf(model);
  try {
    const [row] = await sql<{ threshold: number }[]>`
      select threshold from semantic_cache_thresholds where space = ${space}
    `;
    if (row) return { space, threshold: Number(row.threshold), source: "calibrated" };
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return { space, threshold: config.semanticCache.defaultThreshold, source: "default" };
}

// Full resolution for a lookup: the config's own override wins outright, else
// the inherited (space or default) value. `override` is null for the common case
// of a config that hasn't set one — see BatchSavings.semanticCache.threshold.
async function resolveThreshold(
  model: string,
  override: number | null,
): Promise<EffectiveThreshold> {
  if (override !== null) {
    return { space: spaceOf(model), threshold: override, source: "config" };
  }
  return inheritedThreshold(model);
}

// Find a cached answer for `question`. Embeds the query under the resolved
// CACHE-KEY model (cached in 0020) and, among entries valid for the current
// fingerprint and stored under that same key model, finds the nearest one. A
// match that clears the threshold is only RETURNED AS A HIT when `serve` is true
// (the Settings → Savings toggle); with serving off it's logged as a "would-hit"
// shadow and reported as a miss, so the caller recomputes a fresh answer.
//
// A miss hands back the key vector (so the store doesn't re-embed) and, WHEN THE
// KEY MODEL AND THE CONFIG'S EMBEDDING MODEL COINCIDE, that same vector as the
// retrieval query vector — which is the default case, so the common path still
// embeds exactly once. Decoupled, the key vector is in a foreign space and the
// caller embeds for retrieval itself.
//
// All three settings come from the CALLER (pipeline reads configs.batch_savings)
// rather than being read here, so this stays a pure function of its inputs and
// one lookup can't disagree with another about which config it's serving.
export async function semanticCacheLookup(
  question: string,
  {
    serve,
    threshold: override,
    keyModel: keyModelOverride,
  }: { serve: boolean; threshold: number | null; keyModel: string | null },
): Promise<CacheProbe> {
  const cfg = activeConfig();
  const keyModel = resolveKeyModel(keyModelOverride);
  // Embed under the key model first — the lookup can't proceed without it, so a
  // provider error here surfaces before any cache work. When the key model IS
  // the retrieval model this doubles as the retrieval vector; otherwise the
  // retrieval embed is deferred to the miss path, where it's actually needed.
  const vector = await embedQueryCached(question, keyModel);
  const key: CacheKey = { model: keyModel, vector };
  const queryVector = keyModel === cfg.embeddingModel ? vector : null;
  const miss = { hit: false, key, queryVector } as const;

  try {
    const fingerprint = await currentFingerprint(cfg);
    const rows = await sql<
      { query_text: string; query_vector: number[]; result: CachedResult }[]
    >`
      select query_text, query_vector, result
      from semantic_cache
      where config_id = ${cfg.id}
        and embedding_model = ${keyModel}
        and fingerprint = ${fingerprint}
      order by created_at desc
      limit ${config.semanticCache.maxCandidates}
    `;
    if (rows.length === 0) return miss;

    const entries: CacheEntry<{ text: string; result: CachedResult }>[] = rows.map(
      (r) => ({ vector: r.query_vector, value: { text: r.query_text, result: r.result } }),
    );
    const match = bestMatch(vector, entries);
    // Keyed by the KEY model's space, not the retrieval model's: the cosine
    // being thresholded was computed in the key model's space, and scores aren't
    // comparable across spaces. `source` rides along into the logs — when a hit
    // looks wrong, the first question is always which layer set the floor it
    // cleared.
    const { threshold, source } = await resolveThreshold(keyModel, override);

    // Entity/number guard (docs/semantic-cache-key-model-plan.md, Phase 0): a
    // match that disagrees with the question on a numeral, acronym or quoted
    // span is refused NO MATTER how high its cosine, because that's precisely
    // where cosine can't tell "2023 revenue" from "2024 revenue". Evaluated
    // before the hit decision, and recorded either way — see below.
    const guardBlocked =
      config.semanticCache.entityGuard.enabled &&
      match !== null &&
      !entityGuardPasses(question, match.value.text);

    // Shadow-log the nearest match for threshold calibration (Phase 2 — see
    // docs/semantic-caching-plan.md). Recorded whenever it clears the low
    // shadowLogFloor, INDEPENDENT of the serving threshold and the serve toggle,
    // so calibration has judged examples BELOW today's threshold. Fire-and-
    // forget: a failure here must never affect the answer.
    //
    // Guard-blocked matches are logged too, flagged: the guard trades recall for
    // safety, and the only way to know what that trade cost is to judge the
    // rows it rejected.
    if (match && match.sim >= config.semanticCache.shadowLogFloor) {
      void recordShadow(
        cfg,
        keyModel,
        fingerprint,
        question,
        match.value.text,
        match.value.result.answer,
        match.sim,
        guardBlocked,
      );
    }

    // Only announce the guard when it CHANGED the outcome. A blocked match that
    // wouldn't have cleared the threshold anyway is an ordinary miss, and gets
    // the ordinary miss log below — the guard flag still rides into the shadow
    // row above, so a later sweep at a lower τ can still see it was blocked.
    if (match && guardBlocked && isHit(match.sim, threshold)) {
      console.log(
        `[rag:semantic-cache] guard-blocked sim=${match.sim.toFixed(4)} ≥ ${threshold} (${source}) — ` +
          `entity/number mismatch, reporting a miss. new="${truncate(question)}" ` +
          `matched="${truncate(match.value.text)}"`,
      );
      return miss;
    }

    if (match && isHit(match.sim, threshold)) {
      if (serve) {
        console.log(
          `[rag:semantic-cache] HIT sim=${match.sim.toFixed(4)} ≥ ${threshold} (${source}) — ` +
            `served cached answer, skipped retrieval. new="${truncate(question)}" ` +
            `matched="${truncate(match.value.text)}"`,
        );
        // Fire-and-forget telemetry bump; a failure here must not fail the answer.
        void bumpHit(cfg.id, keyModel, fingerprint, match.value.text);
        void recordSemanticSaving(match.value.result, question);
        return { hit: true, result: match.value.result, sim: match.sim, matchedQuery: match.value.text };
      }
      // Serving is off (Settings → Savings): shadow-log the would-be hit for
      // threshold validation, then report a miss so a fresh answer is computed.
      console.log(
        `[rag:semantic-cache] would-hit sim=${match.sim.toFixed(4)} ≥ ${threshold} (${source}) but ` +
          `serving is OFF — recomputing. new="${truncate(question)}" matched="${truncate(match.value.text)}"`,
      );
      return miss;
    }

    if (match) {
      console.log(
        `[rag:semantic-cache] miss (nearest sim=${match.sim.toFixed(4)} < ${threshold} (${source})) for "${truncate(question)}"`,
      );
    }
    return miss;
  } catch (err) {
    if (isMissingTable(err)) return miss;
    throw err;
  }
}

// Bank a freshly-computed answer under the CACHE-KEY model the lookup resolved
// (`key`, handed back on the miss — so the question is never re-embedded), and
// opportunistically GC entries whose fingerprint no longer matches the config
// (invalidated by a corpus/config/override change). Exact-duplicate questions
// are suppressed by the unique (config, model, fingerprint, query_hash)
// constraint. Best-effort throughout.
//
// The GC is fingerprint-only, so rows keyed under a PREVIOUS key model survive a
// switch instead of being dropped. That's deliberate: they're still valid
// answers, they cost nothing to leave (the lookup filters on embedding_model in
// SQL), and switching back — or backfilling — finds them intact.
export async function semanticCacheStore(
  question: string,
  key: CacheKey,
  result: CachedResult,
): Promise<void> {
  const cfg = activeConfig();
  try {
    const fingerprint = await currentFingerprint(cfg);
    await sql`
      insert into semantic_cache
        (config_id, embedding_model, fingerprint, query_text, query_hash, query_vector, dimension, result)
      values
        (${cfg.id}, ${key.model}, ${fingerprint}, ${question}, ${sha256(question)},
         ${key.vector}::real[], ${key.vector.length}, ${JSON.stringify(result)}::jsonb)
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

// A served hit skipped the GENERATION for this question (docs §2 #3). The query
// embed is NOT counted here — the lookup embeds it regardless, so it isn't
// avoided; only the answer model call is. Tokens are estimated from the banked
// result (context chunks in, answer out) under the model that produced it.
// Called fire-and-forget on the serve hot path, so the WHOLE body is guarded:
// `result` is a jsonb row read back from the DB and its shape is trusted, not
// checked — a malformed row would throw inside the .map() before any inner
// try/catch could see it, and an unhandled rejection takes the process down.
async function recordSemanticSaving(result: CachedResult, question: string): Promise<void> {
  try {
    const contextText = result.sources.map((s) => s.chunk.chunk.text);
    const inTokens = estimateTokensAll(contextText) + estimateTokens(question);
    const outTokens = estimateTokens(result.answer);
    const saved = costLlm(result.model, inTokens, outTokens);
    await recordSaving("semantic_cache", saved, inTokens + outTokens);
  } catch (err) {
    // Telemetry only — swallow so a savings-record failure never breaks a hit.
    console.warn(`[rag:semantic-cache] savings record failed: ${(err as Error).message}`);
  }
}

// Bank a shadow event for calibration (best-effort). Deduped by the unique
// (config, fingerprint, query_hash) constraint, so a repeated question under
// the same validity key records once and doesn't swamp the judged set.
//
// `keyModel` — not cfg.embeddingModel — is what's stamped on the row: `sim` was
// computed in the KEY model's space, and both the sweep and semantic_cache_
// thresholds are keyed by that space. Stamping the retrieval model would file
// the label against a space its number doesn't belong to.
async function recordShadow(
  cfg: ResolvedConfig,
  keyModel: string,
  fingerprint: string,
  newQuery: string,
  matchedQuery: string,
  servedAnswer: string,
  sim: number,
  guardBlocked: boolean,
): Promise<void> {
  try {
    await sql`
      insert into semantic_cache_shadow
        (config_id, embedding_model, space, fingerprint,
         new_query, new_query_hash, matched_query, served_answer, sim, guard_blocked)
      values
        (${cfg.id}, ${keyModel}, ${spaceOf(keyModel)}, ${fingerprint},
         ${newQuery}, ${sha256(newQuery)}, ${matchedQuery}, ${servedAnswer}, ${sim}, ${guardBlocked})
      on conflict (config_id, fingerprint, new_query_hash) do nothing
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    // Migration 0038 not applied yet (undefined_column) → log the event without
    // the flag rather than losing shadow coverage entirely, same spirit as the
    // missing-table tolerance above. Drop this fallback once 0038 is applied.
    if ((err as { code?: string }).code === "42703") {
      await recordShadowPreGuard(cfg, keyModel, fingerprint, newQuery, matchedQuery, servedAnswer, sim);
      return;
    }
    // Telemetry only — swallow so a shadow-log failure never breaks a lookup.
    console.warn(`[rag:semantic-cache] shadow log failed: ${(err as Error).message}`);
  }
}

// Pre-0038 insert shape, used only when guard_blocked doesn't exist yet.
async function recordShadowPreGuard(
  cfg: ResolvedConfig,
  keyModel: string,
  fingerprint: string,
  newQuery: string,
  matchedQuery: string,
  servedAnswer: string,
  sim: number,
): Promise<void> {
  try {
    await sql`
      insert into semantic_cache_shadow
        (config_id, embedding_model, space, fingerprint,
         new_query, new_query_hash, matched_query, served_answer, sim)
      values
        (${cfg.id}, ${keyModel}, ${spaceOf(keyModel)}, ${fingerprint},
         ${newQuery}, ${sha256(newQuery)}, ${matchedQuery}, ${servedAnswer}, ${sim})
      on conflict (config_id, fingerprint, new_query_hash) do nothing
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    console.warn(`[rag:semantic-cache] shadow log failed: ${(err as Error).message}`);
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

// ---------------------------------------------------------------------------
// SWITCHING THE CACHE-KEY MODEL (docs/semantic-cache-key-model-plan.md, Phase 1)
//
// The schema already supports coexistence — semantic_cache keys on
// (config_id, embedding_model, fingerprint, query_hash) with an explicit
// `dimension` and a plain real[] vector — so two key models with different dims
// sit side by side and a switch is non-destructive: old rows simply stop
// matching. What ISN'T free is the safety posture, which is what the two
// helpers below exist for.
// ---------------------------------------------------------------------------

// THE LANDMINE. Thresholds are keyed by spaceOf(model), so switching key models
// moves a config into a new space — and an uncalibrated space falls back to
// defaultThreshold (0.95). That is a silent change to the cosine floor answers
// are served at, in either direction, made as a side effect of picking a model.
//
// So: returns the blocking detail when `model`'s space has NO calibrated row,
// and null when it's safe. Callers must refuse the switch on a non-null result
// (or make the user override it explicitly) — never flip silently. The Settings
// key-model picker and PATCH /api/batch both go through this.
export async function uncalibratedKeyModelSpace(
  model: string,
): Promise<{ space: string; fallbackThreshold: number } | null> {
  const inherited = await inheritedThreshold(model);
  if (inherited.source === "calibrated") return null;
  return { space: inherited.space, fallbackThreshold: inherited.threshold };
}

// What the Settings picker renders: the model in force for this config, where it
// came from, and what its space serves at. `override` is the config's own value
// (configs.batch_savings.semanticCache.keyModel).
export type KeyModelStatus = {
  keyModel: string; // resolved — the model questions are actually keyed under
  override: string | null; // this config's own, null when it inherits
  globalDefault: string; // config.semanticCache.keyModel
  threshold: EffectiveThreshold; // what the resolved model's space serves at
  candidates: { id: string; space: string; dimension: number; provider: string }[];
};

// Every REGISTERED model is a candidate, `ingestable` included or not: the
// cache-key vector never touches a chunks_* table, so it needs neither a
// physical vector table nor a dimension matching the corpus. Provider
// availability is deliberately NOT filtered here — an unkeyed provider is a
// listing the UI can grey out with a reason, same as the base-model picker.
export async function keyModelStatus(override: string | null): Promise<KeyModelStatus> {
  const keyModel = resolveKeyModel(override);
  return {
    keyModel,
    override,
    globalDefault: config.semanticCache.keyModel,
    threshold: await inheritedThreshold(keyModel),
    candidates: Object.values(EMBEDDING_MODELS).map((spec) => ({
      id: spec.id,
      space: spaceOf(spec.id),
      dimension: spec.dimension,
      provider: spec.provider,
    })),
  };
}

export type KeyModelBackfill = {
  keyModel: string;
  candidates: number; // distinct questions found under some OTHER key model
  inserted: number; // rows created under keyModel
  failed: number; // questions whose re-embed threw (provider/key errors)
};

// EAGER BACKFILL: re-embed this config's already-cached questions under
// `keyModel` and insert them as new rows, so a switch doesn't have to wait for
// users to re-ask before the cache has anything to hit against. Offered as an
// explicit action, never an automatic side effect of the switch — it spends
// provider tokens, and how much is a decision the user should get to make.
//
// Only rows under the CURRENT fingerprint are backfilled: anything else holds an
// answer that's already invalid and would be GC'd on the next store, so paying
// to re-key it buys nothing. Embeds go through embedQueryCached, so a question
// already seen under this model costs zero and a re-run of an interrupted
// backfill is nearly free. Sequential on purpose — this is a background action
// with no latency budget, and one request at a time is the kind provider rate
// limits like.
export async function backfillKeyModel(
  keyModel: string,
  limit = 500,
): Promise<KeyModelBackfill> {
  const cfg = activeConfig();
  const empty: KeyModelBackfill = { keyModel, candidates: 0, inserted: 0, failed: 0 };
  try {
    const fingerprint = await currentFingerprint(cfg);
    // One row per distinct question (newest answer wins) that isn't already
    // keyed under the target model.
    const rows = await sql<
      { query_text: string; query_hash: string; result: CachedResult }[]
    >`
      select distinct on (query_hash) query_text, query_hash, result
      from semantic_cache sc
      where config_id = ${cfg.id}
        and fingerprint = ${fingerprint}
        and embedding_model <> ${keyModel}
        and not exists (
          select 1 from semantic_cache k
          where k.config_id = sc.config_id
            and k.fingerprint = sc.fingerprint
            and k.embedding_model = ${keyModel}
            and k.query_hash = sc.query_hash
        )
      order by query_hash, created_at desc
      limit ${limit}
    `;

    const out: KeyModelBackfill = { ...empty, candidates: rows.length };
    for (const row of rows) {
      let vector: number[];
      try {
        vector = await embedQueryCached(row.query_text, keyModel);
      } catch (err) {
        // One unembeddable question must not abandon the rest — a missing
        // provider key fails every row and is obvious from `failed`, while a
        // single bad input shouldn't cost the whole run.
        out.failed += 1;
        console.warn(
          `[rag:semantic-cache] backfill embed failed under ${keyModel}: ${(err as Error).message}`,
        );
        continue;
      }
      const done = await sql`
        insert into semantic_cache
          (config_id, embedding_model, fingerprint, query_text, query_hash, query_vector, dimension, result)
        values
          (${cfg.id}, ${keyModel}, ${fingerprint}, ${row.query_text}, ${row.query_hash},
           ${vector}::real[], ${vector.length}, ${JSON.stringify(row.result)}::jsonb)
        on conflict (config_id, embedding_model, fingerprint, query_hash) do nothing
      `;
      out.inserted += done.count;
    }
    return out;
  } catch (err) {
    if (isMissingTable(err)) return empty;
    throw err;
  }
}
