-- ============================================================================
-- 0047_drop_autotune_trial_timings.sql
--
-- Completes the removal of the autotune speed-trial scaffolding. 0041 added
-- these five columns so repeated timed runs could be grouped by experiment and
-- compared in an Appraise → Trial times tab. The speed work is finished, the
-- levers are in (L2/L10/L11/L12/L13/L14/L15/L18), the tab was removed in
-- 2dd9236, and the harness that set trial_label is deleted — so nothing reads
-- or writes any of this any more.
--
-- Safe to drop, checked before writing:
--   1. No writer. insertAutotuneRun no longer inserts them; the header type
--      lost the fields in the same commit.
--   2. No reader. autotuneStore.listTrialRuns and TrialsSection are gone; the
--      only surviving consumer of run timing is the in-memory durationMs on the
--      autotune-done event, which the dashboard renders and never persisted.
--   3. The data was trial residue. The 24 labelled runs were deleted by Part 2
--      of docs/autotune-trial-cleanup.sql; of the 6 real runs left, only one
--      (2026-08-02) ever carried timings at all.
--
-- This is the second half of that file's Part 4 — the first half (nine unused
-- score/confirm split columns) went in 0042. Part 4 could not run as written
-- because the write path still existed; it does not any more.
--
-- The index goes first: dropping a column silently drops any index over it, but
-- being explicit keeps the intent readable.
-- ============================================================================

drop index if exists autotune_runs_trial_idx;

alter table autotune_runs
  drop column if exists duration_ms,
  drop column if exists search_ms,
  drop column if exists confirm_ms,
  drop column if exists rescore_ms,
  drop column if exists trial_label;
