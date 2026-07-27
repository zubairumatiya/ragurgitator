-- ============================================================================
-- 0037_collision_floor_cache.sql
--
-- Saved collision-floor report — one row per config, the LATEST run only.
--
-- Why it exists: the collision floor (Appraise → Semantic caching, top panel) is
-- an all-pairs cosine sweep over every labeled eval question's cached query
-- vector. It's read-only and cheap in dollars (no LLM calls, no re-embedding —
-- see semanticCacheCalibration.recordEvalEmbedReuse), but it is O(n²) in JS over
-- vectors pulled out of Postgres, and until now the report lived ONLY in React
-- state. Navigating off the page and back threw it away, so the user had to sit
-- through a Compute to look at a number that hadn't changed. This table is that
-- number, kept.
--
-- One row per config (config_id is the PK, not part of a composite): the panel
-- only ever shows "the current floor for this config", so history would be rows
-- nobody reads. A recompute overwrites via ON CONFLICT.
--
-- Keyed by config, not by vector-space, because the report is derived from a
-- config's OWN eval bank — two configs on the same embedding model can have
-- different labeled questions and so different floors. (The threshold the report
-- recommends is per-space; that lives in semantic_cache_thresholds, 0031, and is
-- written only by an explicit Apply. Nothing here is ever served from.)
--
-- Columns mirror CollisionFloorReport (= semanticCacheCore.CollisionFloorResult
-- + space/embedding_model/questions_total) one-for-one, so the store is a plain
-- snake_case → camelCase rename and the client type never changes. The four
-- cosine columns are NULLABLE exactly where the type says `number | null`
-- (fewer than two comparable questions → nothing to measure). They're `real`,
-- matching semantic_cache_thresholds.threshold: the vectors they're computed
-- from are real[] themselves, so float4 is already the precision floor, and the
-- UI rounds to 4dp regardless (see events.emitRecommendation).
--
-- questions_used / questions_total are stored because they are the STALENESS
-- key: questions_total is how many labeled questions the config had when this
-- ran, and the panel compares it against the live count to warn that the bank
-- has moved and the floor should be recomputed.
--
-- Pure cache: safe to truncate — you lose saved reports (the panel goes back to
-- an empty "Compute"), nothing else. Deliberately tolerant of not existing:
-- lib/rag/collisionFloorStore swallows 42P01 so reads return "nothing saved" and
-- writes no-op, making the app behave IDENTICALLY before this migration is
-- applied (same contract as embedding_cache 0020 / semantic_cache 0031 /
-- savings_totals 0034).
-- ============================================================================

create table semantic_cache_collision_floor (
  config_id          uuid        primary key references configs(id) on delete cascade,
  space              text        not null,   -- vector-space tag the floor applies to
  embedding_model    text        not null,   -- model that produced the query vectors
  floor              real,                   -- max cosine among DISTINCT-question pairs
  same_answer_min    real,                   -- min cosine among same-ground-truth pairs
  same_answer_median real,
  recommended        real,                   -- suggested threshold (null = uncalibratable)
  distinct_pairs     int         not null,
  same_answer_pairs  int         not null,
  questions_used     int         not null,   -- questions with a cached vector (the sample)
  questions_total    int         not null,   -- labeled questions at compute time (staleness key)
  overlap            boolean     not null,   -- floor >= same_answer_min: no fully-safe band
  computed_at        timestamptz not null default now()
);
