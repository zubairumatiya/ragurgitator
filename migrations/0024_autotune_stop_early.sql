-- ============================================================================
-- 0024_autotune_stop_early.sql
--
-- "Stop once reached" (Settings → Autotuning): when on, an autotune run halts
-- as soon as every targeted metric's AGGREGATE rate is at/above its min-rate,
-- skipping the remaining below-bar chunks to save embedding cost. Pairs with
-- the engine searching the worst chunks first, so the biggest lifts land
-- before the cutoff. Off by default — existing configs keep chasing every
-- below-bar question.
-- ============================================================================

alter table configs
  add column autotune_stop_early boolean not null default false;
