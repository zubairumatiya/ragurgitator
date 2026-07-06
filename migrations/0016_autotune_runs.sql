-- ============================================================================
-- 0016_autotune_runs.sql
--
-- Phase C of docs/eval-autotuning-plan.md: history for automated per-chunk
-- autotune runs. The run still ends with a normal eval_runs snapshot (that is
-- what Appraise reads); these tables add the per-question, per-chunk
-- before→after detail that a single aggregate eval_runs row can't express —
-- the yellow-circle hover tooltip (Phase D) and the "what did the robot
-- change?" audit.
-- ============================================================================

-- One header row per autotune run: the criteria it targeted and the tallies.
create table autotune_runs (
  id              uuid        primary key default gen_random_uuid(),
  config_id       uuid        not null references configs(id) on delete cascade,
  recall_k        int,
  recall_min_rate real,
  ndcg_k          int,
  ndcg_min_rate   real,
  targeted        int not null default 0,   -- below-bar questions at start
  resolved        int not null default 0,   -- cleared by an applied override
  unresolved      int not null default 0,   -- still below bar (left to manual / pending choice)
  attempts        int not null default 0,   -- experiments run (cost proxy)
  created_at      timestamptz not null default now()
);

create index autotune_runs_config_idx on autotune_runs (config_id, created_at desc);

-- Per-(question, metric) before→after for each targeted question.
create table autotune_question_outcomes (
  autotune_run_id  uuid not null references autotune_runs(id) on delete cascade,
  eval_question_id uuid not null references eval_questions(id) on delete cascade,
  source_chunk_id  uuid not null,
  metric           text not null,             -- 'recall' | 'ndcg'
  before_value     real,                       -- per-question metric before the run
  before_rank      int,
  after_value      real,                       -- after the applied override + final re-score
  after_rank       int,
  override_kind    text,                       -- null = no override applied (unresolved/pending)
  override_model   text,
  override_size    int,
  primary key (autotune_run_id, eval_question_id, metric)
);
