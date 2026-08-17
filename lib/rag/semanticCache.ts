// SEMANTIC CACHE — orchestration (DB-facing). Serves a PAST answer for a NEW
// question when the two are close enough in embedding space, letting ask() skip
// retrieval and generation entirely. The correctness decisions live in the
// dependency-free core (semanticCacheCore.ts); this file is the plumbing.
//
// SCOPE: per USER, not per config, since 0058. An entry is reachable from every
// config of yours holding the same documents and answering with the same model,
// however differently they retrieve — the AB-testing workflow this repo is built
// around is several configs over one corpus, and the old per-config grain made
// each of them buy the same answer over again. config_id survives as provenance.
//
// Best-effort, like embedCache: if 0031 isn't applied (42P01) lookups always miss
// and stores are no-ops, so the feature is safe to ship ahead of the migration.
import { createHash } from "node:crypto";

import { activeUserId } from "@/lib/auth/userScope";
import { config } from "@/lib/config";
import { isolated, sql, toJsonb } from "@/lib/db";
import { detached } from "@/lib/detached";
import { activeConfig, type ResolvedConfig } from "@/lib/rag/activeConfig";
import { getBatchSavings } from "@/lib/rag/batchStore";
import { defaultLabel, getConfig } from "@/lib/rag/configStore";
import { embedQueryCached } from "@/lib/rag/embedCache";
import { EMBEDDING_MODELS } from "@/lib/rag/embeddingModels";
import type { EfficacyResult } from "@/lib/rag/efficacyGate";
import { costLlm, estimateTokens, estimateTokensAll } from "@/lib/rag/pricing";
import { recordSaving } from "@/lib/rag/savingsStore";
import {
  answerFingerprint,
  bestMatch,
  entityGuardPasses,
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

// Provenance of a semantic_cache_shadow row (0069). 'traffic' is a question
// someone actually asked; 'probe' is one a calibration driver synthesised. The
// serving threshold is swept over 'traffic' alone — a curve built from engineered
// near-misses is a worst-case bound, not this account's question distribution.
export type ShadowOrigin = "traffic" | "probe";

// A miss also hands back the RETRIEVAL query vector when the lookup happens to
// already have it — i.e. when the cache-key model and the config's embedding
// model coincide, which is the default. Decoupled, they're vectors in different
// spaces and the key vector is useless to the retriever, so `queryVector` is null
// and the caller embeds for retrieval itself.
//
// A hit carries neither: it skips retrieval AND generation.
export type CacheProbe =
  | { hit: true; result: CachedResult; sim: number; matchedQuery: string }
  | { hit: false; key: CacheKey; queryVector: number[] | null };

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const truncate = (s: string, n = 80): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

// A signature of WHICH DOCUMENTS this config can answer from: the set of document
// ids with chunks ingested under it. Adding or removing a document invalidates
// every banked answer.
//
// Document ids ONLY — deliberately not the chunk count it used to carry:
//   - chunk count moves on every re-chunk, which put chunkSize/chunkOverlap back
//     into the validity key through the back door;
//   - the ids are the half that is comparable ACROSS configs. Two configs over the
//     same corpus hold identical document ids even though their per-model chunk
//     tables and counts differ, which is what lets them share one bucket.
//
// Keying on ids is sound because document CONTENT is immutable: insertDocument
// always mints a fresh uuid — no on-conflict, no update path — so a re-upload is
// a new id.
//
// Read from the CHUNKS table rather than corpus_documents on purpose: chunks are
// what retrieval can reach, so a document in the corpus but not yet ingested here
// can't appear in an answer and must not join the key.
async function documentSignature(cfg: ResolvedConfig): Promise<string> {
  try {
    const [row] = await sql<{ docs: string }[]>`
      select
        coalesce(md5(string_agg(distinct document_id::text, ',' order by document_id::text)), 'empty') as docs
      from ${sql(cfg.chunksTable)}
      where config_id = ${cfg.id}
    `;
    return row.docs;
  } catch (err) {
    if (isMissingTable(err)) return "no-corpus";
    throw err;
  }
}

// The validity key an entry is stored under and looked up by: what would make the
// banked answer WRONG, and nothing else.
//
// Deliberately absent: chunkSize, chunkOverlap, topK, fusionPool, the retrieval
// embedding model and the override state. Those describe HOW the answer was
// found, not WHETHER it is still true — nudging topK used to throw away every
// banked answer and re-buy it at full price. The cost is that the cache can mask
// a retrieval change while you tune; the answer is the "Serve cached answers"
// toggle, which forces recomputation and shadow-logs the would-hits.
//
// The CACHE-KEY model is absent for a different reason: it changes only how
// questions are INDEXED for lookup, not what answer was produced, and it has a
// column of its own — folding it in would needlessly invalidate every cached
// ANSWER on a key-model switch.
//
// llmModel is absent because it is a COLUMN as of 0058, sitting in the lookup's
// where-clause instead so /cache can name the answering model per row.
// cascadeEnabled stays in the hash: it modifies that model rather than being an
// identity anyone wants to filter on.
//
// SYSTEM_PROMPT is not in this hash either. It is a static const and the app has
// no prompt editing, so only a code edit can change it — at which point bump
// `sc-vN` in answerFingerprint in the same commit. That manual bump is the whole
// invalidation mechanism for the prompt; there is deliberately no derived
// prompt_version.
async function currentFingerprint(cfg: ResolvedConfig): Promise<string> {
  return answerFingerprint({
    cascadeEnabled: cfg.cascadeEnabled,
    documents: await documentSignature(cfg),
  });
}

// --- the cache-key model ---------------------------------------------------

// The embedding model incoming questions are keyed under for the proximity match:
//
//   configs.batch_savings.semanticCache.keyModel   (per-config override)
//     ?? config.semanticCache.keyModel             (global default)
//
// NOT the config's retrieval model: the key vector never touches a chunks_* table,
// so it needs neither `ingestable` nor a matching dimension.
//
// An override naming an unregistered model falls back to the global default
// rather than throwing — the alternative is a provider error on the answer hot
// path over a stale jsonb value.
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

// The precision the calibration sweeps hold themselves to:
//
//   configs.batch_savings.semanticCache.acceptTarget  (per-config override)
//     ?? config.semanticCache.acceptTarget            (global default, 0.99)
//
// A PROBABILITY, not a cosine: the rule that derives τ from judged evidence, where
// `threshold` is a hand-set τ. Both sweeps take it as a PARAMETER rather than
// reading it here — the pages hosting them are not config-scoped, so a target read
// deep in the stack would silently be the Default config's.
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

// The cosine threshold governing hits, INHERITED for this model's vector space: a
// calibrated value if one exists, else the conservative default. This is what a
// config with no override runs at, and what the Settings input shows as its
// placeholder.
//
// Per (user, space) since 0050, and that predicate is load-bearing rather than
// hygienic: without it the last account to calibrate sets the floor at which EVERY
// account's cache serves a stored answer instead of computing a fresh one.
export async function inheritedThreshold(model: string): Promise<EffectiveThreshold> {
  const space = spaceOf(model);
  try {
    const [row] = await sql<{ threshold: number }[]>`
      select threshold from semantic_cache_thresholds
      where user_id = ${activeUserId()} and space = ${space}
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
// CACHE-KEY model and, among entries valid for the current fingerprint and stored
// under that same key model, finds the nearest one.
//
// The candidate set is THIS USER's, across all of their configs (0058). What still
// separates buckets is the answering model (`llm_model`, an explicit column), the
// key model's vector space, and the fingerprint's document set + saver mode.
//
// A match clearing the threshold is only RETURNED AS A HIT when `serve` is true;
// with serving off it's logged as a "would-hit" shadow and reported as a miss.
//
// A miss hands back the key vector (so the store doesn't re-embed) and, WHEN THE
// KEY MODEL AND THE CONFIG'S EMBEDDING MODEL COINCIDE, that same vector as the
// retrieval query vector — the default case, so the common path embeds once.
//
// All three settings come from the CALLER rather than being read here, so this
// stays a pure function of its inputs and one lookup can't disagree with another
// about which config it's serving.
//
// `shadow` overrides how the nearest match is shadow-logged, and exists for
// CALIBRATION DRIVERS ONLY — no serving path passes it, so live traffic keeps the
// configured floor and the 'traffic' origin. A probe pass uses it to record below
// shadowLogFloor without lowering the floor globally (docs/resume-metrics-plan.md
// §F2: whether 0.80 should move is the question being measured, so the
// measurement can't presuppose an answer) and to stamp its rows 'probe' so they
// stay out of the live recommendation (0069).
export async function semanticCacheLookup(
  question: string,
  {
    serve,
    threshold: override,
    keyModel: keyModelOverride,
    shadow,
  }: {
    serve: boolean;
    threshold: number | null;
    keyModel: string | null;
    shadow?: { floor?: number; origin?: ShadowOrigin };
  },
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
      where user_id = ${activeUserId()}
        and embedding_model = ${keyModel}
        and llm_model = ${cfg.llmModel}
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

    // Shadow-log the nearest match for threshold calibration. Recorded whenever it
    // clears the low shadowLogFloor, INDEPENDENT of the serving threshold and the
    // serve toggle, so calibration has judged examples BELOW today's threshold.
    // Fire-and-forget: a failure here must never affect the answer.
    //
    // Guard-blocked matches are logged too, flagged: the guard trades recall for
    // safety, and the only way to know what that cost is to judge what it rejected.
    //
    // BELOW the floor, a small random sample is logged too (F5). The floor is not
    // lowered — F2 settled that 0.80 stays — but a band nothing is ever recorded
    // from cannot be shown to have changed, so a fraction of it is sampled to make
    // drift visible on a different corpus, key model or question mix. Only on the
    // live path: a driver passing `shadow` is already choosing its own floor, and
    // a probe pass runs at floor 0 where "below the floor" means nothing.
    const floor = shadow?.floor ?? config.semanticCache.shadowLogFloor;
    const subFloorSample =
      shadow === undefined &&
      match !== null &&
      match.sim < floor &&
      Math.random() < config.semanticCache.subFloorSampleRate;

    if (match && (match.sim >= floor || subFloorSample)) {
      await detached(() =>
        recordShadow(
          cfg,
          keyModel,
          fingerprint,
          question,
          match.value.text,
          match.value.result.answer,
          match.sim,
          guardBlocked,
          shadow?.origin ?? "traffic",
        ),
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
        // Deferred telemetry; a failure must not fail the answer, and the caller must not
        // wait for it. These two are the reason lib/detached.ts exists: a served hit
        // returns straight out of ask() and /api/chat does no further database work, so a
        // bare `void` here issued its SQL after the request's transaction had already
        // committed — the semantic cache under-reported on EVERY served hit, precisely
        // when it worked.
        //
        // userId is read HERE, not inside the closure: a value captured at queue time
        // can't be wrong later.
        const userId = activeUserId();
        await detached(() =>
          bumpHit(userId, keyModel, cfg.llmModel, fingerprint, match.value.text),
        );
        await detached(() => recordSemanticSaving(match.value.result, question));
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
// (`key`, handed back on the miss, so the question is never re-embedded).
// Exact-duplicate questions are suppressed by the unique (user, key model, llm
// model, fingerprint, query_hash) constraint. `config_id` is written as
// provenance — "which config first banked this" — and is no longer ownership.
export async function semanticCacheStore(
  question: string,
  key: CacheKey,
  result: CachedResult,
): Promise<void> {
  const cfg = activeConfig();
  try {
    const fingerprint = await currentFingerprint(cfg);
    // isolated so the `isMissingTable` escape below is real: swallowing a 42P01
    // that had already aborted the request's transaction would leave the caller
    // continuing inside a transaction every later statement fails in.
    await isolated(
      () => sql`
        insert into semantic_cache
          (user_id, config_id, embedding_model, llm_model, fingerprint,
           query_text, query_hash, query_vector, dimension, result)
        values
          (${activeUserId()}, ${cfg.id}, ${key.model}, ${cfg.llmModel}, ${fingerprint},
           ${question}, ${sha256(question)},
           ${key.vector}::real[], ${key.vector.length}, ${toJsonb(result)})
        on conflict (user_id, embedding_model, llm_model, fingerprint, query_hash) do nothing
      `,
    );
    await pruneByVolume();
  } catch (err) {
    if (isMissingTable(err)) return;
    throw err;
  }
}

// Keep one user's cache bounded, occasionally. THE GC THIS REPLACED was
// `delete … where config_id = <cfg> and fingerprint <> <current>`, safe only
// because a config had exactly ONE live fingerprint at a time. Ported naively to
// `where user_id = …` it becomes a data-loss bug: a user holds several live
// fingerprints at once — one per (document set × saver mode) — so storing an
// answer under one config would delete the ENTIRE cache of another, on every
// store.
//
// Computing "every fingerprint currently live across this user's configs" per
// store would mean a document-signature query per config on the answer hot path.
// Not worth it for a table whose stale rows are merely UNREACHABLE, never wrong:
// they age out by volume instead. Sampled rather than run every time — the cap is
// a ceiling, not a quota.
//
// The sub-select ranks the rows to KEEP (most-served, then newest) and offsets
// past the cap, so what's deleted is the tail: cold and old first. A stale
// fingerprint's rows sort to the bottom on their own as live ones accumulate hits.
async function pruneByVolume(): Promise<void> {
  if (Math.random() * config.semanticCache.pruneEvery >= 1) return;
  await isolated(
    () => sql`
      delete from semantic_cache
      where id in (
        select id from semantic_cache
        where user_id = ${activeUserId()}
        order by hit_count desc, created_at desc
        offset ${config.semanticCache.maxEntriesPerUser}
      )
    `,
  );
}

// A served hit skipped the GENERATION for this question. The query embed is NOT
// counted — the lookup embeds it regardless, so it isn't avoided. Tokens are
// estimated from the banked result under the model that produced it.
//
// Called fire-and-forget on the serve hot path, so the WHOLE body is guarded:
// `result` is a jsonb row whose shape is trusted, not checked — a malformed row
// would throw inside the .map() before any inner try/catch could see it, and an
// unhandled rejection takes the process down.
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
// (config, fingerprint, query_hash) constraint, so a repeated question under the
// same validity key records once and doesn't swamp the judged set.
//
// `keyModel` — not cfg.embeddingModel — is what's stamped: `sim` was computed in
// the KEY model's space, and both the sweep and semantic_cache_thresholds are
// keyed by that space. Stamping the retrieval model would file the label against
// a space its number doesn't belong to.
//
// `origin` (0069) separates real traffic from calibration probes; see the lookup's
// `shadow` option for why that has to be a stored fact.
//
// Columns added by a migration are OPTIONAL at insert time: each is dropped from
// the row and the insert retried when postgres reports it undefined (42703), so a
// deployment running ahead of its migrations keeps logging shadow events with
// less detail instead of losing them. Ordered newest migration first, since that
// is the one most likely to be missing.
const SHADOW_OPTIONAL_COLUMNS = ["origin", "guard_blocked"] as const;

async function recordShadow(
  cfg: ResolvedConfig,
  keyModel: string,
  fingerprint: string,
  newQuery: string,
  matchedQuery: string,
  servedAnswer: string,
  sim: number,
  guardBlocked: boolean,
  origin: ShadowOrigin,
): Promise<void> {
  const row: Record<string, unknown> = {
    config_id: cfg.id,
    embedding_model: keyModel,
    space: spaceOf(keyModel),
    fingerprint,
    new_query: newQuery,
    new_query_hash: sha256(newQuery),
    matched_query: matchedQuery,
    served_answer: servedAnswer,
    sim,
    guard_blocked: guardBlocked,
    origin,
  };

  for (const dropped of [null, ...SHADOW_OPTIONAL_COLUMNS]) {
    if (dropped) delete row[dropped];
    try {
      await isolated(
        () => sql`
          insert into semantic_cache_shadow ${sql(row)}
          on conflict (config_id, fingerprint, new_query_hash) do nothing
        `,
      );
      return;
    } catch (err) {
      if (isMissingTable(err)) return;
      if ((err as { code?: string }).code === "42703") continue;
      // Telemetry only — swallow so a shadow-log failure never breaks a lookup.
      console.warn(`[rag:semantic-cache] shadow log failed: ${(err as Error).message}`);
      return;
    }
  }
  console.warn("[rag:semantic-cache] shadow log failed: no insert shape matched the table");
}

// Matches on the FULL key, llm_model included: the same question banked under
// two answering models is two rows, and bumping on (user, key model,
// fingerprint) alone would credit a hit to a homonym the lookup never served.
async function bumpHit(
  userId: string,
  model: string,
  llmModel: string,
  fingerprint: string,
  matchedQuery: string,
): Promise<void> {
  try {
    await isolated(
      () => sql`
        update semantic_cache
        set hit_count = hit_count + 1, last_hit_at = now()
        where user_id = ${userId} and embedding_model = ${model}
          and llm_model = ${llmModel}
          and fingerprint = ${fingerprint} and query_hash = ${sha256(matchedQuery)}
      `,
    );
  } catch (err) {
    if (isMissingTable(err)) return;
    // Telemetry only — swallow so a bump failure never breaks a served answer.
    console.warn(`[rag:semantic-cache] hit-count bump failed: ${(err as Error).message}`);
  }
}

// SWITCHING THE CACHE-KEY MODEL
//
// The schema already supports coexistence — semantic_cache keys on (user_id,
// embedding_model, llm_model, fingerprint, query_hash) with an explicit
// `dimension` and a plain real[] vector — so two key models with different dims
// sit side by side and a switch is non-destructive: old rows simply stop matching.
// What ISN'T free is the safety posture, which is what the two helpers below are for.

// THE LANDMINE. Thresholds are keyed by spaceOf(model), so switching key models
// moves a config into a new space — and an uncalibrated space falls back to
// defaultThreshold (0.95). That is a silent change to the cosine floor answers are
// served at, in either direction, made as a side effect of picking a model.
//
// So: returns the blocking detail when `model`'s space has NO calibrated row, and
// null when it's safe. Callers must refuse the switch on a non-null result (or
// make the user override it explicitly) — never flip silently.
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

// EAGER BACKFILL: re-embed this user's already-cached questions under `keyModel`
// and insert them as new rows, so a switch doesn't have to wait for users to
// re-ask before the cache has anything to hit against. An explicit action, never
// an automatic side effect — it spends provider tokens.
//
// Since 0058 this spans the user's WHOLE ACCOUNT, which is what makes a key-model
// switch one operation instead of a per-config chore. `llm_model` is therefore
// carried through from each source row rather than read from `cfg`.
//
// Only rows under the RUNNING CONFIG'S fingerprint are backfilled, so the run
// never re-keys answers that are already invalid. The fingerprint is the document
// set plus saver mode, so this reaches every config sharing those two — but a user
// holding a SECOND corpus re-keys it by running the backfill from a config over
// that corpus.
//
// Embeds go through embedQueryCached, so a re-run of an interrupted backfill is
// nearly free. Sequential on purpose — a background action with no latency budget,
// and one request at a time is the kind provider rate limits like.
export async function backfillKeyModel(
  keyModel: string,
  limit = 500,
): Promise<KeyModelBackfill> {
  const cfg = activeConfig();
  const userId = activeUserId();
  const empty: KeyModelBackfill = { keyModel, candidates: 0, inserted: 0, failed: 0 };
  try {
    const fingerprint = await currentFingerprint(cfg);
    // One row per distinct (question, answering model) — newest answer wins —
    // that isn't already keyed under the target model. llm_model is part of the
    // grouping AND of the not-exists, because it is part of the key: the same
    // question answered by two models is two rows, and collapsing them would
    // re-key one and silently strand the other.
    const rows = await sql<
      {
        query_text: string;
        query_hash: string;
        llm_model: string;
        config_id: string | null;
        result: CachedResult;
      }[]
    >`
      select distinct on (query_hash, llm_model)
             query_text, query_hash, llm_model, config_id, result
      from semantic_cache sc
      where user_id = ${userId}
        and fingerprint = ${fingerprint}
        and embedding_model <> ${keyModel}
        and not exists (
          select 1 from semantic_cache k
          where k.user_id = sc.user_id
            and k.fingerprint = sc.fingerprint
            and k.llm_model = sc.llm_model
            and k.embedding_model = ${keyModel}
            and k.query_hash = sc.query_hash
        )
      order by query_hash, llm_model, created_at desc
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
      // config_id is carried from the SOURCE row, not taken from the running
      // config: it is provenance for the answer, and the answer is the source
      // row's. (It may be null there — a banking config since deleted.)
      const done = await sql`
        insert into semantic_cache
          (user_id, config_id, embedding_model, llm_model, fingerprint,
           query_text, query_hash, query_vector, dimension, result)
        values
          (${userId}, ${row.config_id}, ${keyModel}, ${row.llm_model}, ${fingerprint},
           ${row.query_text}, ${row.query_hash},
           ${vector}::real[], ${vector.length}, ${toJsonb(row.result)})
        on conflict (user_id, embedding_model, llm_model, fingerprint, query_hash) do nothing
      `;
      out.inserted += done.count;
    }
    return out;
  } catch (err) {
    if (isMissingTable(err)) return empty;
    throw err;
  }
}

// --- the "My cache" listing ------------------------------------------------

// One row of the /cache page: a question this user has had answered, and the
// answer banked for it.
export type CacheEntrySummary = {
  id: string;
  question: string;
  answer: string;
  hitCount: number;
  // Provenance — which config FIRST banked this — not who it's served to. Null
  // when that config has since been deleted (0058 made config_id `on delete set
  // null`, so the answer outlives it).
  configLabel: string | null;
  // The model that produced the answer. Since entries are shared across configs
  // this, not the config label, is the row's real identity.
  llmModel: string;
  keyModel: string;
  createdAt: number;
  lastHitAt: number | null;
};

// Cap the listing. This page is a "what has my cache learned" browse, not an
// export, so an unbounded scan buys nothing even though pruneByVolume now keeps
// the table bounded per user.
const LIST_LIMIT = 500;

// Every cached answer this user owns, most-served first. Filtered on
// semantic_cache.user_id directly since 0058; the join to configs is purely for
// the provenance LABEL and is a LEFT join — config_id is nullable, and a row whose
// banking config was deleted is still a live, servable answer.
//
// Deliberately reads `result->>'answer'` rather than the whole `result` blob: the
// jsonb also holds `sources`, a full RetrievedChunk[] per row, which this page
// never renders. Selecting it would pull megabytes of chunk text out of the DB to
// display a truncated preview.
export async function listCacheEntries(): Promise<CacheEntrySummary[]> {
  try {
    const rows = await sql<
      {
        id: string;
        query_text: string;
        answer: string | null;
        hit_count: number;
        name: string | null;
        base_model: string | null;
        chunk_size: number | null;
        chunk_overlap: number | null;
        llm_model: string;
        embedding_model: string;
        created_at: Date;
        last_hit_at: Date | null;
      }[]
    >`
      select
        sc.id,
        sc.query_text,
        sc.result->>'answer' as answer,
        sc.hit_count,
        c.name,
        c.base_model,
        c.chunk_size,
        c.chunk_overlap,
        sc.llm_model,
        sc.embedding_model,
        sc.created_at,
        sc.last_hit_at
      from semantic_cache sc
      left join configs c on c.id = sc.config_id
      where sc.user_id = ${activeUserId()}
      order by sc.hit_count desc, sc.created_at desc
      limit ${LIST_LIMIT}
    `;
    return rows.map((r) => ({
      id: r.id,
      question: r.query_text,
      // `answer` is null only if a row's jsonb predates the current shape or was
      // hand-written; the cell renders empty rather than the string "null".
      answer: r.answer ?? "",
      hitCount: r.hit_count,
      // Null config ⇒ the banking config is gone. Reported as null so the UI can
      // say so, rather than manufacturing a label out of null columns.
      configLabel:
        r.base_model === null
          ? null
          : (r.name ?? defaultLabel(r.base_model, r.chunk_size!, r.chunk_overlap!)),
      llmModel: r.llm_model,
      keyModel: r.embedding_model,
      createdAt: r.created_at.getTime(),
      lastHitAt: r.last_hit_at?.getTime() ?? null,
    }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}
