-- ============================================================================
-- 0038_shadow_guard_blocked.sql
--
-- Records whether the ENTITY/NUMBER GUARD refused a shadow-logged match
-- (docs/semantic-cache-key-model-plan.md, Phase 0).
--
-- The guard blocks a match whose numerals, ALLCAPS acronyms or quoted spans
-- differ from the incoming question — "what was 2023 revenue" vs "what was 2024
-- revenue" sits near 0.98 cosine under every embedding model, so no serving
-- threshold separates them. Blocked matches are reported as misses.
--
-- Why the column: the guard can only ever cost RECALL (it turns would-be hits
-- into misses, never the reverse), and the size of that cost is an empirical
-- question, not an argument to be won. A blocked match is still logged here,
-- flagged — so a later sweep can judge those rows and read off exactly how much
-- savings the guard walked past. Without the flag the rejections are invisible
-- and the guard's own effect can't be scored.
--
-- Existing rows predate the guard, so `false` is the correct backfill: nothing
-- was blocked before it shipped. NOT NULL with a default keeps the insert path
-- free to omit the column (semanticCache.recordShadow falls back to a
-- column-less insert on 42703, so shadow logging survives an unapplied 0038).
-- ============================================================================

alter table semantic_cache_shadow
  add column guard_blocked boolean not null default false;
