-- ============================================================================
-- 0035_semantic_cache_shadow.sql
--
-- Shadow log for semantic-cache threshold calibration (Phase 2, part B —
-- docs/semantic-caching-plan.md). Every lookup whose nearest cached query
-- clears config.semanticCache.shadowLogFloor records a row here — the new
-- question, the query it matched, the answer that WOULD have been served, and
-- the cosine — INDEPENDENT of whether the match cleared the (serving)
-- threshold and independent of the per-config serve toggle. That last part is
-- the point: to calibrate the threshold DOWNWARD we need judged examples with
-- sim BELOW today's default (0.95), which the serving path never surfaces.
--
-- Rows start unjudged (verdict null). Judging is on demand: a batch LLM pass
-- (bulk model over everything, boundary model over the crossover band) and/or
-- a human Accept/Reject queue, both on the Appraise → Semantic caching page.
-- The verdict column is the sole input to the precision-at-threshold sweep
-- (calibrateFromJudged): sort by sim desc, pick the lowest τ where
-- P(accept | sim ≥ τ) ≥ config.semanticCache.acceptTarget.
--
-- `space` is stored (not just embedding_model) because the sweep and the
-- thresholds table are keyed by vector-space (semanticCacheCore.spaceOf) —
-- storing it avoids re-deriving it in aggregate queries.
--
-- Pure telemetry: safe to truncate; the app tolerates this table not existing
-- (42P01) and degrades to a no-op, exactly like semantic_cache (0031).
-- ============================================================================

create table semantic_cache_shadow (
  id              uuid        primary key default gen_random_uuid(),
  config_id       uuid        not null references configs(id) on delete cascade,
  embedding_model text        not null,   -- base model that produced the vectors
  space           text        not null,   -- spaceOf(embedding_model); sweep/threshold key
  fingerprint     text        not null,   -- validity key at capture time (see 0031)
  new_query       text        not null,   -- the incoming question
  new_query_hash  text        not null,   -- sha256(new_query), for dedupe
  matched_query   text        not null,   -- the nearest cached question
  served_answer   text        not null,   -- answer that would have been served
  sim             real        not null,   -- cosine(new_query, matched_query)
  verdict         text,                    -- null | 'accept' | 'reject'
  judge_source    text,                    -- null | 'llm' | 'human'
  judge_model     text,                    -- the model that produced an llm verdict
  judge_reason    text,                    -- one-line rationale (llm)
  judged_at       timestamptz,
  created_at      timestamptz not null default now(),
  -- One shadow row per (config, validity, question): a repeated question under
  -- the same fingerprint updates nothing (keeps the judged set from being
  -- swamped by a single hot query).
  unique (config_id, fingerprint, new_query_hash)
);

-- The calibration read path: unjudged-first scans and per-space sweeps over one
-- config's rows, ordered by similarity.
create index semantic_cache_shadow_calib_idx
  on semantic_cache_shadow (config_id, space, sim desc);

-- Fast "how many still need judging" counts and the human-queue scan.
create index semantic_cache_shadow_unjudged_idx
  on semantic_cache_shadow (config_id, verdict, created_at desc);
