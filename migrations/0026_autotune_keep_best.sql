-- ============================================================================
-- 0026_autotune_keep_best.sql
--
-- "Keep best effort" (Settings → Autotuning): when on, a chunk where NO
-- candidate clears the bar keeps the best strictly-improving candidate anyway
-- (confirmed through real retrieval: reverted unless the targeted metrics'
-- values improved with no new failures). The question stays below its
-- min-rate but ranks closer than before. Off by default — existing configs
-- keep the all-or-nothing behavior.
--
-- autotune_runs.improved counts targeted questions that ended the run still
-- below the bar but with a better value on a targeted metric (a subset of
-- `unresolved`, so resolved + unresolved still equals targeted).
-- ============================================================================

alter table configs
  add column autotune_keep_best boolean not null default false;

alter table autotune_runs
  add column improved integer not null default 0;
