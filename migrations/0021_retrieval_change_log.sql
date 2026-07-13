-- ============================================================================
-- 0021_retrieval_change_log.sql
--
-- Human-readable log of the override/delegate changes behind the config's
-- retrieval_changed_at stamp (0019). One row per set/clear, e.g.
-- "resume.pdf · chunk #3: delegate → voyage-3 (was baseline)". The dashboard's
-- stale badge lists these on hover so the user can see exactly which changes
-- made the current metrics approximate. Cleared when a full re-score
-- ("Process new chunks" / unscoped "Re-score all") brings everything fresh
-- again; also cascades away with the config.
--
-- source_chunk_id has no FK for the same reason as config_chunk_overrides:
-- chunks live in per-model tables.
-- ============================================================================

create table config_retrieval_changes (
  id              uuid        primary key default gen_random_uuid(),
  config_id       uuid        not null references configs(id) on delete cascade,
  source_chunk_id uuid,
  description     text        not null,
  created_at      timestamptz not null default now()
);

-- The badge tooltip reads a config's changes newest-first.
create index config_retrieval_changes_config_idx
  on config_retrieval_changes (config_id, created_at desc);
