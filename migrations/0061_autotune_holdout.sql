-- ============================================================================
-- 0061_autotune_holdout.sql
--
-- Phase 2b of docs/resume-metrics-plan.md: a held-out TEST SET as a real
-- autotune setting instead of a hand-managed ignore list.
--
-- THE UNIT IS QUESTIONS, NOT CHUNKS. Holding out chunks would mean autotune
-- never touches them, so their post-tune delta is ~0 by construction — that
-- measures "we didn't tune these", not generalization. Holding out questions
-- keeps the chunk in the search (it is still reshaped from its train questions)
-- and asks whether the reshape helps queries it was NOT fitted to.
--
-- No new table: the draw writes into config_question_ignores (0014) with
-- reason = 'holdout', because that table is already excluded at all three
-- points where leakage could occur — target selection, the confirm veto ("no
-- new failures"), and the keepBest progress sum. The reason string is what
-- separates a drawn test question from a human's "ignore in rates" click, so a
-- redraw never eats a manual ignore.
--
-- The seed is stored, not just used. Without it the split is not reproducible
-- and the generalization number cannot be re-derived or defended.
-- ============================================================================

alter table configs
  add column autotune_holdout_enabled boolean not null default false,
  -- 'pct' => size is a percentage of the labeled question set; 'count' => size
  -- is an absolute number of questions. No CHECK: the parse is owned by
  -- lib/rag/evalSettingsStore.ts, which falls back to 'pct' on anything else.
  add column autotune_holdout_mode    text    not null default 'pct',
  add column autotune_holdout_size    real    not null default 25,
  add column autotune_holdout_seed    int     not null default 1;

-- The draw and every read of it filter on this reason, and a config's ignore
-- list is small but read on every autotune target pass.
create index config_question_ignores_holdout_idx
  on config_question_ignores (config_id)
  where reason = 'holdout';
