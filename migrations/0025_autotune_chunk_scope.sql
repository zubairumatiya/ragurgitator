-- ============================================================================
-- 0025_autotune_chunk_scope.sql
--
-- "Chunks" scope (Settings → Autotuning): restrict an autotune run to specific
-- chunks, picked per document in the Settings dropdown. NULL (the default)
-- means ALL chunks — including ones labeled after the setting was saved. A
-- non-null array whitelists source chunk ids (the config's base-table chunk
-- ids, no FK — per-model chunk tables, like config_chunk_overrides); the
-- engine skips below-bar questions whose chunk isn't listed.
-- ============================================================================

alter table configs
  add column autotune_chunk_scope uuid[];
