-- ============================================================================
-- 0027_fusion_pool.sql
--
-- Configurable FUSION CANDIDATE POOL, split by consumer (Settings dropdown):
--
--   retrieval_fusion_pool — how many base-model ANN candidates live retrieval
--   (and eval scoring / model trials, which share fuseWithOverrides) re-embeds
--   under each override model to position the overridden chunks' fusion ranks.
--   NULL = auto, the historical max(top_k * 4, 50). This value shapes fusion
--   semantics, so it's folded into retrievalStateFingerprint (0022): changing
--   it flags scored results stale whenever overrides exist.
--
--   autotune_fusion_pool — the same knob for autotune's approximate candidate
--   search only (fusedTrialRanks). Smaller = far fewer first-encounter
--   embeddings per (question, model) trial, at the cost of coarser deep ranks.
--   NULL = follow live retrieval. Search-only, so it does NOT affect the
--   fingerprint — the per-chunk confirm re-score (real retrieval) stays the
--   arbiter and simply reverts over-promises.
--
-- Both effective values are clamped to at least the retrieval k at use time.
-- ============================================================================

alter table configs
  add column retrieval_fusion_pool integer,
  add column autotune_fusion_pool integer;
