-- ============================================================================
-- 0014_eval_criteria.sql
--
-- Phase A of docs/eval-autotuning-plan.md: make /eval criteria-driven instead of
-- "auto-generate one question per chunk and always score Recall + nDCG".
--
-- Per-config eval criteria, saved on the config so a run is reproducible and
-- comparable in Appraise (D3): which metrics are enabled, each metric's own k
-- (A1 — null falls back to top_k) and optional min-rate, and the difficulty mix
-- generation tops up to. Plus the autotuning settings the Settings dropdown edits
-- (A5) — stored now, consumed by the Phase C engine. All additive with defaults
-- that preserve today's behaviour for the existing Default config (both metrics
-- on at top_k; empty difficulty set = legacy no-difficulty generation).
--
-- Also creates config_question_ignores (manual false-positive mode, Phase D) so
-- Phase D needs no further migration; it sits unused until then.
-- ============================================================================

alter table configs
  -- --- metrics (A1) ---
  add column recall_enabled  boolean not null default true,
  add column recall_k        int,            -- null => fall back to top_k
  add column recall_min_rate real,           -- null => metric runs but no autotune target
  add column ndcg_enabled    boolean not null default true,
  add column ndcg_k          int,
  add column ndcg_min_rate   real,
  -- subset of {easy,medium,hard}; '{}' = legacy no-difficulty generation
  add column eval_difficulties text[] not null default '{}',
  -- --- autotuning settings (A5; edited from the Settings dropdown) ---
  add column autotune_size_ladder int[]  not null default '{384,256,192,128}',
  add column autotune_overlap_pct real   not null default 0.10,   -- overlap = round(size * pct)
  add column autotune_apply        text  not null default 'choose',         -- 'choose' | 'auto_best'
  add column autotune_search       text  not null default 'first_success';  -- 'first_success' | 'exhaustive'

-- Config-scoped "ignore this question in rates" (manual false-positive mode).
-- Config-scoped because a question can be a legit miss in one config and a
-- distractor artifact in another. Unused until Phase D.
create table config_question_ignores (
  config_id        uuid        not null references configs(id)       on delete cascade,
  eval_question_id uuid        not null references eval_questions(id) on delete cascade,
  reason           text,
  created_at       timestamptz not null default now(),
  primary key (config_id, eval_question_id)
);
