-- ============================================================================
-- 0036_shadow_indexes.sql
--
-- Fix the semantic_cache_shadow indexes to match the queries that actually run.
--
-- 0035 created both indexes leading with config_id, on the assumption that the
-- calibration reads were config-scoped. They aren't: shadow events are pooled
-- per VECTOR-SPACE (see semanticCacheCore.spaceOf), and every read filters by
-- `space` alone — calibrationCurve, judgeShadowEvents, listShadowSpaces,
-- listShadowEvents. Postgres can't use a config_id-leading btree for a
-- space-only predicate, so all four fell back to sequential scans.
--
-- Replacements match the two real access shapes:
--   (space, sim desc)  — the sweep and the event listing, both `where space = ?
--                        ... order by sim desc limit ?`.
--   (space, verdict)   — the judged/unjudged counts (count(*) / count(verdict)
--                        grouped by space) and the `verdict is null` filter the
--                        bulk judge pass uses to find unjudged rows.
--
-- The unique (config_id, fingerprint, new_query_hash) constraint from 0035 is
-- CORRECTLY config-scoped (dedupe on insert) and is left untouched.
-- ============================================================================

drop index if exists semantic_cache_shadow_calib_idx;
drop index if exists semantic_cache_shadow_unjudged_idx;

create index semantic_cache_shadow_space_sim_idx
  on semantic_cache_shadow (space, sim desc);

create index semantic_cache_shadow_space_verdict_idx
  on semantic_cache_shadow (space, verdict);
