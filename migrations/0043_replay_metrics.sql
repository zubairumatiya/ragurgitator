-- ============================================================================
-- 0043_replay_metrics.sql
--
-- OFFLINE REPLAY — full-corpus retrieval metrics for every candidate embedding
-- model, computed from vectors ALREADY sitting in embedding_cache (0020).
-- Backs the "measured performance" table on /appraise/models.
--
-- Why this exists: the only cross-model evidence we had was eval_model_trials,
-- which re-ranks within a tiny candidate pool that contains the right chunk by
-- construction — every model scored 1.000, so nothing could be compared. The
-- replay instead ranks the WHOLE corpus for each model, using the same chunk
-- texts, the same labelled questions, and the same exact-cosine scan for all of
-- them. First run measured a real spread (MRR .800–.881 across 7 models), and it
-- costs nothing: no provider calls, no re-ingest, no chunks table touched.
--
-- THIS IS A CACHE, not a record. The computation is deterministic given its
-- inputs, so a row is only ever a saved answer to "what would the replay say?".
-- Safe to truncate: everything recomputes on next view (~3s, dominated by
-- pulling ~15MB of vectors out of embedding_cache — which is the entire reason
-- this table exists rather than computing per request).
--
--   fingerprint — md5 over the inputs that define the experiment: the config,
--     its corpus chunk texts, its (question, gold chunk) labels, and a count of
--     document-kind cache rows. A mismatch means recompute. The document count
--     deliberately OVER-invalidates: any ingest or trial anywhere bumps it, so
--     we recompute occasionally when nothing relevant changed. That's the cheap
--     side of the trade — the exact alternative (per-model coverage) costs a
--     hash join per model on every page load just to decide.
--
--   coverage_chunks / corpus_chunks — a model is only scored when it has a
--     cached vector for EVERY corpus chunk. Scoring a subset would shrink the
--     candidate pool and inflate the metrics, which is the exact bias the
--     replay exists to escape. Under-covered models are stored with null
--     metrics so the page can say "not scorable" rather than omitting them.
--
-- Best-effort like savings_totals (0034) / embedding_cache (0020): the reader
-- swallows 42P01 and recomputes in-process when the table is absent, so the
-- page works identically with or without this migration applied.
-- ============================================================================

create table replay_metrics (
  fingerprint     text        not null,  -- md5 of the inputs; mismatch ⇒ recompute
  config_id       uuid        not null references configs(id) on delete cascade,
  model           text        not null,  -- EMBEDDING_MODELS id
  questions       int         not null,  -- labelled questions actually scored
  corpus_chunks   int         not null,  -- chunks in the config's corpus
  coverage_chunks int         not null,  -- of those, ones this model has cached
  -- Null when coverage is incomplete (see above) — the model is listed, unscored.
  recall_at_1     numeric,
  recall_at_3     numeric,
  recall_at_5     numeric,
  recall_at_10    numeric,
  mrr             numeric,
  computed_at     timestamptz not null default now(),
  primary key (fingerprint, config_id, model)
);

-- The read path: "every model's row for this config at this fingerprint".
create index replay_metrics_lookup_idx
  on replay_metrics (config_id, fingerprint);
