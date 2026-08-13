-- ============================================================================
-- 0066_background_job_unit_failures.sql
--
-- "SUCCEEDED 472/472" WHEN IT GRADED 196.
--
-- That is a real line from the Phase 6 run in docs/resume-metrics-plan.md, and it
-- is not a counting bug. Steps swallow per-unit failures on purpose — one bad
-- question must not abort a forty-minute sweep — and report them through the
-- event stream instead. In the STREAMED driver a human is reading that stream, so
-- the failures are visible. In the BACKGROUND driver nothing consumes `event` at
-- all: the runner reads `doneUnits` and drops the rest. So every swallowed failure
-- vanishes, the job reaches its last unit, and it truthfully reports that it
-- processed all of them.
--
-- 0064 is the neighbouring column and a different thing: `failures` counts SLICES
-- that threw and rolled back, which is the retry budget. These count UNITS that
-- failed inside a slice that then committed successfully — work that is simply
-- missing from a job the panel calls succeeded.
--
--   failed_units     how many units the step reported as failed.
--   last_unit_error  the most recent one's message — a breadcrumb that outlives
--                    the stream, which is exactly what the aborted-transaction
--                    case of 2026-08-13 did not have.
--
-- DELIBERATELY NOT EXACT. Written out of band like done_units, and incremented
-- rather than recomputed, so a slice that dies after committing work and gets
-- retried can count one failure twice. It errs high, which is the right direction
-- for a signal whose only job is to stop "finished" from meaning "finished
-- cleanly" when it didn't.
-- ============================================================================

alter table background_jobs
  add column failed_units integer not null default 0,
  add column last_unit_error text;
