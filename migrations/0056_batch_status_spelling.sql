-- ============================================================================
-- 0056_batch_status_spelling.sql
--
-- Respells two batch_jobs.status values: 'canceling' -> 'cancelling' and
-- 'canceled' -> 'cancelled'.
--
-- WHY THIS IS A MIGRATION AND NOT JUST A RENAME IN THE CODE — the panel renders
-- the STORED string directly (BatchRequestsPanel: job.status.replace("_", " ")),
-- so the value in this column is user-visible text, not just an internal token.
-- Renaming only the TypeScript union would leave historical rows spelled the old
-- way, rendering with the fallback badge style and failing every isTerminal /
-- isPollable check that now spells it the other way — i.e. an old cancelled job
-- would stop offering its acknowledge button.
--
-- The 0029 comment block still shows the old spelling. That is deliberate: a
-- past migration is a record of what was applied then, not a place to rewrite.
--
-- `status` is plain text with no check constraint (0029), so there is no
-- constraint to drop and re-add — the values are the whole of it.
--
-- Idempotent: re-running matches nothing the second time.
-- ============================================================================

update batch_jobs set status = 'cancelling' where status = 'canceling';
update batch_jobs set status = 'cancelled'  where status = 'canceled';
