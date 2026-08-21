-- ============================================================================
-- 0074_autotune_run_holdout.sql
--
-- THE HOLDOUT'S MEMBERSHIP IS MUTABLE AND DESTRUCTIVE; ITS RESULT MUST NOT BE.
--
-- 0061 stores the test set as rows in config_question_ignores with
-- reason = 'holdout'. That was the right call for exclusion — it buys the three
-- leak guards for free — but it means the split is a CURRENT fact and nothing
-- else. syncHoldout deletes every 'holdout' row on each redraw, and folding the
-- holdout back in deletes them all. The moment the seed changes, or enough
-- questions arrive for the draw to top up, the set a finished run was tested on
-- is unrecoverable. That is why docs/resume-metrics-results.md had to be derived
-- by hand and frozen into a JSON snapshot: the numbers existed, briefly, in rows
-- that the next redraw ate.
--
-- So a run records its own test set, and its own numbers, at the moment it
-- closes its books.
--
--   autotune_run_holdout  who was held out FOR RUN X, with before/after per
--                         question. Deliberately the same shape as
--                         autotune_question_outcomes and a complementary
--                         population: that table holds the questions the run
--                         TARGETED, this one holds the questions it was
--                         FORBIDDEN TO SEE.
--
--                         Per-question rather than aggregate-only, because the
--                         next question anyone serious asks is "which held-out
--                         questions still miss", and because the improved /
--                         regressed / unchanged split has to be computable
--                         without re-running a script over rows that no longer
--                         exist.
--
-- WHY BOTH SIDES ON THE RUN ROW. A holdout rate with no train rate beside it is
-- a number nobody can interpret, and printing one alone is the exact misreading
-- resume-metrics-results.md warns about — optimization capability presented as
-- generalization. The two are stored together so no reader can render one
-- without the other being right there.
--
-- holdout_split_key: sha256 over the run's held-out question ids, sorted
-- ascending, first 12 hex. Two runs share a key IFF they were tested on exactly
-- the same questions, which is the whole reconciliation primitive — same key,
-- deltas stack; different key, they are measurements of different things and the
-- UI has to say so. The stored (mode, size, seed) triple CANNOT do this job: the
-- draw tops up as questions arrive, so one seed over a grown question set yields
-- a different set. The key is computed from what was actually held, never from
-- the dials that asked for it.
--
-- holdout_contaminated: true when any question this run held out was TARGETED by
-- an earlier run of the same config. Once that has happened the run's holdout
-- number measures optimization, not generalization, and no amount of care later
-- undoes it — it is the one-way door from resume-metrics pass two, made a
-- property of the row instead of something someone has to remember.
--
-- ALL NULLABLE AND UNBACKFILLED, on the 0065/0068 precedent. Runs older than
-- this genuinely do not know what their holdout was, and defaulting holdout_n to
-- 0 would assert precisely the thing these columns exist to stop assuming: it
-- would make "this run had no holdout" and "we were not recording yet" the same
-- row.
-- ============================================================================

create table autotune_run_holdout (
  autotune_run_id  uuid not null references autotune_runs(id) on delete cascade,
  eval_question_id uuid not null references eval_questions(id) on delete cascade,
  -- Frozen in freezePlan, against the same settled corpus the plan is frozen
  -- against — not at t=0, for the reason that file's header gives.
  before_hit   boolean,
  before_rank  int,
  before_rr    real,
  before_ndcg  real,
  -- Read off the run's closing getSummary(). Genuine post-run retrieval: held-out
  -- questions are excluded from RATES and TARGETING, never from SCORING.
  after_hit    boolean,
  after_rank   int,
  after_rr     real,
  after_ndcg   real,
  primary key (autotune_run_id, eval_question_id)
);

alter table autotune_runs
  -- The split's identity. holdout_n is the null/not-null flag every reader
  -- gates on: null means this run predates the recording, not that it held
  -- nothing out.
  add column holdout_n            int,
  add column holdout_mode         text,
  add column holdout_size         real,
  add column holdout_seed         int,
  add column holdout_split_key    text,
  add column holdout_contaminated boolean,
  -- Both sides, both ends.
  add column train_n               int,
  add column train_recall_before   real, add column train_recall_after   real,
  add column train_mrr_before      real, add column train_mrr_after      real,
  add column train_ndcg_before     real, add column train_ndcg_after     real,
  add column holdout_recall_before real, add column holdout_recall_after real,
  add column holdout_mrr_before    real, add column holdout_mrr_after    real,
  add column holdout_ndcg_before   real, add column holdout_ndcg_after   real;

-- The contamination check asks "did an EARLIER run of this config target any of
-- these question ids". 0016 gave autotune_question_outcomes a primary key led by
-- autotune_run_id, so that question is a full scan of the table without this.
create index autotune_question_outcomes_question_idx
  on autotune_question_outcomes (eval_question_id);

-- Derived-table policy, the 0051:280 form used by autotune_question_outcomes.
-- Required, not optional: the rls_auto_enable event trigger (0073) switches RLS
-- on for every new table in public, so a policy-less table is deny-all to
-- rag_app — empty reads, rejected writes, and no error anywhere.
create policy rag_app_owner on autotune_run_holdout
  for all to rag_app
  using (exists (select 1 from autotune_runs r where r.id = autotune_run_holdout.autotune_run_id))
  with check (exists (select 1 from autotune_runs r where r.id = autotune_run_holdout.autotune_run_id));
