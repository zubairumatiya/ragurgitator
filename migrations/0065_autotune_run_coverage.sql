-- ============================================================================
-- 0065_autotune_run_coverage.sql
--
-- A RUN THAT STOPPED IS NOT A SWEEP THAT FINISHED.
--
-- 0016 gave autotune_runs `targeted` and `resolved`, and every reader has since
-- read them as a rate: 22 of 74 resolved is a 30% run. That reading is only true
-- when the run actually visited all 74 chunks. Three things already stop a run
-- mid-sweep — stopEarly (0024), the durable cancel, and now the soft time budget
-- (docs/autotune-slicing-plan.md §2) — and after any of them `targeted` counts
-- questions the run never looked at. The history row misreports coverage as
-- failure, silently, and the more useful the run was going to be the worse the
-- misreport.
--
-- So the row records HOW it ended and HOW FAR it got:
--
--   stop_reason       null = ran the whole sweep. 'budget' | 'cancelled' |
--                     'early' otherwise. Text rather than an enum for the same
--                     reason the rest of this schema avoids them: a new stop
--                     condition should not need a migration to be recordable.
--   chunks_total      chunks the run TARGETED at start.
--   chunks_searched   chunks it actually searched. Equal to chunks_total on a
--                     completed sweep, which is what makes "N of M" honest
--                     without a second query.
--
-- Nullable and unbackfilled: rows written before this migration genuinely do not
-- know their coverage, and inventing chunks_searched = chunks_total for them
-- would assert exactly the thing the columns exist to stop assuming.
-- ============================================================================

alter table autotune_runs
  add column stop_reason text,
  add column chunks_total integer,
  add column chunks_searched integer;
