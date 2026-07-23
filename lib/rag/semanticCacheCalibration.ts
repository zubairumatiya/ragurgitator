// ---------------------------------------------------------------------------
// SEMANTIC CACHE — Phase 2 calibration orchestration (DB-facing). The pure
// math (collision floor, precision-at-threshold sweep) lives in
// semanticCacheCore.ts; this file is the plumbing: read the eval bank / shadow
// log, run the LLM judge, and upsert per-space thresholds. See
// docs/semantic-caching-plan.md.
//
// Two calibration paths, both writing semantic_cache_thresholds:
//   A. Collision floor — from the ACTIVE config's eval bank (config-scoped;
//      call inside withRequestConfig). No LLM calls, available immediately.
//   B. Shadow judge — from real would-hit traffic pooled per vector-space
//      (global). An on-demand LLM pass and/or human Accept/Reject labels feed
//      the sweep.
//
// Best-effort against missing tables (42P01), like the rest of the cache.
// ---------------------------------------------------------------------------
import { anthropicClient } from "@/lib/llm/client";
import { config } from "@/lib/config";
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import { allLabeledQuestions, getCachedQueryEmbeddings } from "@/lib/rag/evalStore";
import {
  calibrateFromJudged,
  collisionFloor,
  spaceOf,
  type CalibrationResult,
  type CollisionFloorResult,
} from "@/lib/rag/semanticCacheCore";

// Missing table (pre-migration) → treat the read as empty. Mirrors semanticCache.
// Typed on the row element so a bare `[]` fallback unifies with postgres.js's
// RowList return type.
async function safe<T>(fn: () => Promise<T[]>, fallback: T[]): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return fallback;
    throw err;
  }
}

// --- A. Collision floor (config-scoped) ------------------------------------

export type CollisionFloorReport = CollisionFloorResult & {
  space: string;
  embeddingModel: string;
  questionsTotal: number; // labeled questions before dropping any without a cached vector
};

// Compute the collision floor for the active config's vector-space from its
// labeled eval questions and their already-cached query embeddings. Does NOT
// write — the caller applies the recommendation explicitly.
export async function computeCollisionFloor(): Promise<CollisionFloorReport> {
  const cfg = activeConfig();
  const labels = await allLabeledQuestions();
  const ids = [...new Set(labels.map((l) => l.questionId))];
  const vectors = await getCachedQueryEmbeddings(ids, cfg.embeddingModel);
  const result = collisionFloor(
    labels.map((l) => ({ questionId: l.questionId, sourceChunkId: l.sourceChunkId })),
    vectors,
    config.semanticCache.collisionMargin,
  );
  return {
    ...result,
    space: spaceOf(cfg.embeddingModel),
    embeddingModel: cfg.embeddingModel,
    questionsTotal: ids.length,
  };
}

// --- Threshold table (global) ----------------------------------------------

// Upsert the calibrated threshold for a vector-space. `notes`/`sampleSize`
// record where it came from (collision-floor vs shadow-judge n=…).
export async function applyThreshold(
  space: string,
  threshold: number,
  sampleSize: number | null,
  notes: string,
): Promise<void> {
  await sql`
    insert into semantic_cache_thresholds (space, threshold, calibrated_at, sample_size, notes)
    values (${space}, ${threshold}, now(), ${sampleSize}, ${notes})
    on conflict (space) do update
      set threshold     = excluded.threshold,
          calibrated_at = excluded.calibrated_at,
          sample_size   = excluded.sample_size,
          notes         = excluded.notes
  `;
}

export type ThresholdReport = {
  space: string;
  threshold: number;
  source: "default" | "calibrated";
  sampleSize: number | null;
  calibratedAt: string | null;
  notes: string | null;
  cacheEntries: number; // banked answers across configs in this space
  totalHits: number;
  lastHitAt: string | null;
  shadowTotal: number;
  shadowJudged: number;
};

// Per-space threshold + cache/shadow stats, across every config. Cache stats are
// grouped by embedding_model in SQL, then folded into spaces in JS (spaceOf is a
// JS-side mapping); shadow counts group by the stored `space` column directly.
export async function listThresholdsWithStats(): Promise<ThresholdReport[]> {
  const [thresholds, cacheRows, shadowRows] = await Promise.all([
    safe(
      () =>
        sql<
          { space: string; threshold: number; calibrated_at: Date; sample_size: number | null; notes: string | null }[]
        >`select space, threshold, calibrated_at, sample_size, notes from semantic_cache_thresholds`,
      [] as { space: string; threshold: number; calibrated_at: Date; sample_size: number | null; notes: string | null }[],
    ),
    safe(
      () =>
        sql<{ embedding_model: string; entries: number; hits: number; last_hit: Date | null }[]>`
          select embedding_model,
                 count(*)::int as entries,
                 coalesce(sum(hit_count), 0)::int as hits,
                 max(last_hit_at) as last_hit
          from semantic_cache group by embedding_model`,
      [] as { embedding_model: string; entries: number; hits: number; last_hit: Date | null }[],
    ),
    safe(
      () =>
        sql<{ space: string; total: number; judged: number }[]>`
          select space, count(*)::int as total, count(verdict)::int as judged
          from semantic_cache_shadow group by space`,
      [] as { space: string; total: number; judged: number }[],
    ),
  ]);

  // Fold cache stats (per embedding_model) into spaces.
  const cacheBySpace = new Map<string, { entries: number; hits: number; lastHit: Date | null }>();
  for (const r of cacheRows) {
    const space = spaceOf(r.embedding_model);
    const acc = cacheBySpace.get(space) ?? { entries: 0, hits: 0, lastHit: null };
    acc.entries += r.entries;
    acc.hits += r.hits;
    if (r.last_hit && (!acc.lastHit || r.last_hit > acc.lastHit)) acc.lastHit = r.last_hit;
    cacheBySpace.set(space, acc);
  }
  const shadowBySpace = new Map(shadowRows.map((r) => [r.space, r]));
  const thresholdBySpace = new Map(thresholds.map((t) => [t.space, t]));

  const spaces = new Set<string>([
    ...thresholdBySpace.keys(),
    ...cacheBySpace.keys(),
    ...shadowBySpace.keys(),
  ]);

  return [...spaces]
    .map((space) => {
      const t = thresholdBySpace.get(space);
      const c = cacheBySpace.get(space);
      const s = shadowBySpace.get(space);
      return {
        space,
        threshold: t ? Number(t.threshold) : config.semanticCache.defaultThreshold,
        source: (t ? "calibrated" : "default") as "default" | "calibrated",
        sampleSize: t?.sample_size ?? null,
        calibratedAt: t ? t.calibrated_at.toISOString() : null,
        notes: t?.notes ?? null,
        cacheEntries: c?.entries ?? 0,
        totalHits: c?.hits ?? 0,
        lastHitAt: c?.lastHit ? c.lastHit.toISOString() : null,
        shadowTotal: s?.total ?? 0,
        shadowJudged: s?.judged ?? 0,
      };
    })
    .sort((a, b) => a.space.localeCompare(b.space));
}

// --- B. Shadow judge (global, per space) -----------------------------------

export type ShadowSpace = {
  space: string;
  total: number;
  judged: number;
  minSim: number;
  maxSim: number;
};

// Spaces that have shadow events, for the space picker.
export async function listShadowSpaces(): Promise<ShadowSpace[]> {
  return safe(
    () =>
      sql<ShadowSpace[]>`
        select space,
               count(*)::int as total,
               count(verdict)::int as judged,
               min(sim)::float as "minSim",
               max(sim)::float as "maxSim"
        from semantic_cache_shadow
        group by space
        order by total desc`,
    [],
  );
}

export type ShadowEvent = {
  id: string;
  newQuery: string;
  matchedQuery: string;
  servedAnswer: string;
  sim: number;
  verdict: "accept" | "reject" | null;
  judgeSource: "llm" | "human" | null;
  judgeModel: string | null;
  judgeReason: string | null;
  createdAt: string;
};

// List shadow events in a space for inspection / the human queue.
export async function listShadowEvents(opts: {
  space: string;
  filter?: "unjudged" | "judged" | "all";
  limit?: number;
}): Promise<ShadowEvent[]> {
  const filter = opts.filter ?? "all";
  const limit = Math.min(opts.limit ?? 100, 500);
  const filterCond =
    filter === "unjudged"
      ? sql`and verdict is null`
      : filter === "judged"
        ? sql`and verdict is not null`
        : sql``;
  const rows = await safe(
    () =>
      sql<
        {
          id: string;
          new_query: string;
          matched_query: string;
          served_answer: string;
          sim: number;
          verdict: "accept" | "reject" | null;
          judge_source: "llm" | "human" | null;
          judge_model: string | null;
          judge_reason: string | null;
          created_at: Date;
        }[]
      >`
        select id, new_query, matched_query, served_answer, sim,
               verdict, judge_source, judge_model, judge_reason, created_at
        from semantic_cache_shadow
        where space = ${opts.space} ${filterCond}
        order by sim desc
        limit ${limit}`,
      [],
  );
  return rows.map((r) => ({
    id: r.id,
    newQuery: r.new_query,
    matchedQuery: r.matched_query,
    servedAnswer: r.served_answer,
    sim: Number(r.sim),
    verdict: r.verdict,
    judgeSource: r.judge_source,
    judgeModel: r.judge_model,
    judgeReason: r.judge_reason,
    createdAt: r.created_at.toISOString(),
  }));
}

const JUDGE_SYSTEM = `You are evaluating a semantic answer cache for a retrieval-augmented question-answering system.
You are given a NEW question and a STORED ANSWER the cache would serve for it (that answer was originally written for a different but similar question).
Decide whether the STORED ANSWER would be an acceptable, correct, and sufficiently complete answer to the NEW question — as if the user had asked the NEW question and received the STORED ANSWER.
Reply on a SINGLE line in exactly this form:
VERDICT: <accept|reject> — <one short reason>
Use "accept" only if a user asking the NEW question would be well served by the STORED ANSWER; otherwise "reject".`;

// One judge call. Returns null verdict when the reply can't be parsed (we then
// leave the row unjudged rather than guess).
async function judgeOne(
  model: string,
  newQuery: string,
  servedAnswer: string,
): Promise<{ verdict: "accept" | "reject" | null; reason: string }> {
  const resp = await anthropicClient.messages.create({
    model,
    max_tokens: 200,
    system: JUDGE_SYSTEM,
    messages: [
      { role: "user", content: `NEW QUESTION:\n${newQuery}\n\nSTORED ANSWER:\n${servedAnswer}` },
    ],
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const m = /verdict:\s*(accept|reject)/i.exec(text);
  const verdict = m ? (m[1].toLowerCase() as "accept" | "reject") : null;
  const reason = text.replace(/^[\s\S]*?verdict:\s*(accept|reject)\s*[—-]?\s*/i, "").trim();
  return { verdict, reason: (reason || text.trim()).slice(0, 500) };
}

export type JudgeRunResult = {
  judged: number;
  accepted: number;
  rejected: number;
  skipped: number;
  model: string;
};

// On-demand batch LLM judge over a space. Default targets UNJUDGED rows (the
// bulk pass); `rejudge: true` also re-labels prior LLM verdicts within the band
// (the boundary pass), but never overrides a HUMAN verdict. Sequential to keep
// well under provider rate limits; the caller caps volume with `limit` and can
// re-run.
export async function judgeShadowEvents(opts: {
  space: string;
  model: string;
  simMin?: number;
  simMax?: number;
  limit?: number;
  rejudge?: boolean;
}): Promise<JudgeRunResult> {
  const simMin = opts.simMin ?? 0;
  const simMax = opts.simMax ?? 1;
  const limit = Math.min(opts.limit ?? 100, 500);
  const rejudge = opts.rejudge ?? false;
  // Compose the "which rows to (re)judge" predicate as a SQL fragment — a JS
  // ternary can't live inside the tagged template. Bulk = still unjudged;
  // boundary re-judge = anything not human-judged.
  const target = rejudge
    ? sql`judge_source is distinct from 'human'`
    : sql`verdict is null`;

  const rows = await safe(
    () =>
      sql<{ id: string; new_query: string; served_answer: string }[]>`
        select id, new_query, served_answer
        from semantic_cache_shadow
        where space = ${opts.space}
          and sim >= ${simMin} and sim <= ${simMax}
          and ${target}
        order by sim desc
        limit ${limit}`,
      [],
  );

  let accepted = 0;
  let rejected = 0;
  let skipped = 0;
  for (const row of rows) {
    let out: { verdict: "accept" | "reject" | null; reason: string };
    try {
      out = await judgeOne(opts.model, row.new_query, row.served_answer);
    } catch (err) {
      console.warn(`[rag:semantic-cache] judge call failed: ${(err as Error).message}`);
      skipped++;
      continue;
    }
    if (!out.verdict) {
      skipped++;
      continue;
    }
    await sql`
      update semantic_cache_shadow
      set verdict = ${out.verdict}, judge_source = 'llm', judge_model = ${opts.model},
          judge_reason = ${out.reason}, judged_at = now()
      where id = ${row.id}`;
    if (out.verdict === "accept") accepted++;
    else rejected++;
  }

  return { judged: accepted + rejected, accepted, rejected, skipped, model: opts.model };
}

// A single human Accept/Reject. Overrides any LLM verdict on the row.
export async function setHumanVerdict(
  id: string,
  verdict: "accept" | "reject",
): Promise<void> {
  await sql`
    update semantic_cache_shadow
    set verdict = ${verdict}, judge_source = 'human', judge_model = null,
        judge_reason = null, judged_at = now()
    where id = ${id}`;
}

export type CalibrationReport = CalibrationResult & { space: string };

// Run the precision-at-threshold sweep over a space's judged shadow events.
export async function calibrationCurve(space: string): Promise<CalibrationReport> {
  const rows = await safe(
    () =>
      sql<{ sim: number; verdict: "accept" | "reject" }[]>`
        select sim, verdict from semantic_cache_shadow
        where space = ${space} and verdict is not null`,
      [],
  );
  const result = calibrateFromJudged(
    rows.map((r) => ({ sim: Number(r.sim), verdict: r.verdict })),
    config.semanticCache.acceptTarget,
    config.semanticCache.minCalibrationSamples,
  );
  return { ...result, space };
}
