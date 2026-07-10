-- ============================================================================
-- 0019_retrieval_changed_at.sql
--
-- When a per-chunk override (delegate model / size / size+model) is set or
-- cleared, the config's retrieval behavior changes GLOBALLY — the overridden
-- chunk competes in every query via RRF fusion, so every stored eval result
-- was produced by a retrieval that no longer exists. Stamp the moment of the
-- last such change on the config; the eval layer treats any result scored
-- before it as stale (same semantics as a question edited after its score):
-- it shows the amber "stale" badge, counts as pending, and is re-scored by
-- the next "Process new chunks" / "Re-score all".
--
-- NULL = retrieval never changed (no override activity yet) → nothing stale.
-- ============================================================================

alter table configs
  add column retrieval_changed_at timestamptz;
