-- ============================================================================
-- 0064_background_job_failures.sql
--
-- ONE FLAKY CALL MUST NOT END A FORTY-MINUTE JOB.
--
-- Found the first time a real background re-score ran: a single Voyage embedding
-- request failed with "fetch failed" — a transient network error, on question 35
-- of 80 — and the whole job went terminal. For a streamed run that is merely
-- annoying (the user is watching, and presses the button again). For a job whose
-- entire promise is "close the tab and we'll email you", it is the promise
-- breaking over something that would have worked on the next try.
--
-- The cursor already makes the fix cheap: a failed slice rolled its work back, so
-- the job is sitting on its last committed checkpoint and re-running from there is
-- exactly what a retry is. All that was missing is knowing when to stop retrying.
--
-- CONSECUTIVE, NOT CUMULATIVE. Reset to zero by any slice that commits a cursor
-- (i.e. that made progress), so a long job that hits an unrelated blip every ten
-- minutes runs to completion, while one that cannot get past the same question
-- gives up after a few tries instead of ticking itself forever.
--
-- Distinct from `attempts`, which counts every slice ever claimed and is how a
-- stuck job is spotted in the panel. This counts only the ones that threw.
-- ============================================================================

alter table background_jobs
  add column failures integer not null default 0;
