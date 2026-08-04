-- ============================================================================
-- 0042_drop_autotune_score_splits.sql
--
-- Removes nine per-phase timing columns that were added to autotune_runs by
-- hand during the 2026-08-02/03 speed trials and never got a migration file.
-- This file exists to close that gap: a schema audit on 2026-08-04 found these
-- were the ONLY columns in the database (of 338) not traceable to a migration.
--
-- They were a finer breakdown of 0041's search_ms/confirm_ms — splitting the
-- dry-run scoring into setup/embed/retrieve/ann/pieces/write, and the confirm
-- phase into chunk-questions/persist/snapshot — cut while hunting for where an
-- 840s autotune run actually spent its time. Once the levers landed on branch
-- autotune-speed the instrumentation that fed them was stripped, but the
-- columns stayed behind in the live DB.
--
-- Safe to drop, on three independent checks made before writing this:
--   1. Nothing references them. insertAutotuneRun (lib/rag/autotuneStore.ts)
--      inserts only 0041's five columns; no reader exists either, including
--      the Trial times page, which reads duration/search/confirm/rescore only.
--   2. They hold no data. All nine are NULL across every surviving row — the
--      runs that populated them were the trial runs deleted by Part 2 of
--      docs/autotune-trial-cleanup.sql.
--   3. No branch depends on them. autotune-speed never wrote them, and
--      user-accounts' committed autotuneStore.ts does not either.
--
-- NOT DROPPED — 0041's five columns (duration_ms, search_ms, confirm_ms,
-- rescore_ms, trial_label) and autotune_runs_trial_idx. Those are live: still
-- written on every run and read by Appraise → Trial times. Part 4 of
-- docs/autotune-trial-cleanup.sql would take them too; it bundles both groups
-- together, which is why only this half is being run. Dropping the rest means
-- first removing the write path, which branch autotune-speed already has.
--
-- `if exists` so the file is a no-op on a database that never had them.
-- ============================================================================

alter table autotune_runs
  drop column if exists score_setup_ms,
  drop column if exists score_embed_ms,
  drop column if exists score_retrieve_ms,
  drop column if exists score_ann_ms,
  drop column if exists score_pieces_ms,
  drop column if exists score_write_ms,
  drop column if exists confirm_chunk_qs_ms,
  drop column if exists confirm_persist_ms,
  drop column if exists confirm_snapshot_ms;
