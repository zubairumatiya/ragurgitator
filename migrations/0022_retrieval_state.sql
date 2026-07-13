-- ============================================================================
-- 0022_retrieval_state.sql
--
-- Revert-aware staleness. retrieval_changed_at (0019) is a one-way clock: a
-- delegate set + revert stamps it twice, leaving every earlier result stale
-- even though retrieval is back to the shape they were scored under. Instead,
-- stamp each result with a FINGERPRINT of the override state it was scored
-- under (sha-256 of the config's canonical override rows; 'baseline' when
-- none — see overrideStore.retrievalStateFingerprint). A result is stale when
-- its fingerprint differs from the current one, so reverting a change makes
-- the old results valid again instantly — and autotune's set-then-revert
-- candidates no longer stale the whole corpus.
--
-- NULL = scored before this migration; those rows fall back to the 0019
-- timestamp rule until their next re-score stamps them. No backfill needed.
-- ============================================================================

alter table eval_results
  add column retrieval_state text;
