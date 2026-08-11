-- ============================================================================
-- 0058_semantic_cache_user_scope.sql
--
-- Re-scopes the semantic answer cache from ONE CONFIG to ONE USER, and moves the
-- answering model out of the validity hash into a column of its own.
--
-- Supersedes the grain chosen by 0031_semantic_cache.sql,
-- (config_id, embedding_model, fingerprint, query_hash), which is wrong in the
-- way this repo is actually used: the AB-testing workflow is several configs
-- over ONE corpus, so asking the same question under each bought the same answer
-- once per config. Every other cache in the system has already made this move —
-- embedding_cache (0050) and question_cache (0055) are both per-user and
-- config-free. See docs/semantic-cache-user-scope-plan.md.
--
-- THE NEW KEY, field by field:
--   user_id         the tenancy boundary, replacing config_id. Leads the unique
--                   constraint so account deletion cascades down one index range
--                   and no separate FK index is needed — 0050's reasoning for
--                   embedding_cache, applied here.
--   embedding_model the CACHE-KEY model (unchanged). A cosine is only meaningful
--                   within one vector space.
--   llm_model       NEW COLUMN. The answering model is part of what the answer
--                   IS: serving a weak model's answer while the user runs a
--                   strong one misreports the config and would corrupt the
--                   Appraise → Models comparison. It is a column rather than a
--                   hash input so /cache can name the answering model per row —
--                   which matters far more now that entries are shared across
--                   configs and the config label no longer identifies a row —
--                   and so a future "serve any model's answer, labelled" mode is
--                   reachable without a re-key.
--   fingerprint     now just the DOCUMENT SET plus the saver-mode flag, hashed
--                   under a bumped "sc-v2" tag (lib/rag/semanticCache.ts,
--                   currentFingerprint). chunkSize, chunkOverlap, topK,
--                   fusionPool, the retrieval embedding model and the override
--                   state are all gone from it: they describe how the answer was
--                   FOUND, not whether it is still TRUE.
--   query_hash      unchanged.
--
-- WHY cascade_enabled (via the fingerprint) and not llm_model alone: with saver
-- mode on, answerWithCascade (lib/rag/pipeline.ts) answers from
-- cheapModelFor(cfg.llmModel) and only escalates on an efficacy failure. Two
-- configs with an IDENTICAL llm_model, one in saver mode, answer from different
-- models. config_id in the lookup used to hide that; under user scoping it would
-- become live.
--
-- EXISTING ROWS ARE INTENTIONALLY ABANDONED, NOT MIGRATED. The sc-v1 → sc-v2
-- bump already makes every pre-existing row unreachable, and llm_model leaving
-- the hash moves it a second time. Recomputing fingerprints here would mean
-- deriving a per-config document signature in SQL against dynamic
-- chunks_<model>_<dim> table names — a lot of migration machinery to save a
-- handful of answers in a table that is a pure cache and currently holds 8 rows.
-- They age out through the volume pruner in semanticCacheStore. This is a
-- decision, not an oversight.
--
-- CONFIG_ID SURVIVES AS PROVENANCE ONLY — "which config first banked this" — so
-- the /cache listing can still show a config label. It MUST stop cascading:
-- with `on delete cascade` left in place, deleting one config would delete
-- answers other configs are now legitimately sharing, which is the exact failure
-- this change exists to prevent.
-- ============================================================================

alter table semantic_cache
  add column user_id   uuid references user_profiles(id) on delete cascade,
  add column llm_model text;

-- Backfill both through the config that banked each row, then lock them down.
-- llm_model is the config's CURRENT model, which is only right because the
-- sc-v2 bump has already made every one of these rows unreachable — this is
-- filling a not-null, not preserving a key.
update semantic_cache sc
   set user_id   = coalesce(sc.user_id, c.user_id),
       llm_model = coalesce(sc.llm_model, c.llm_model)
  from configs c
 where c.id = sc.config_id;

alter table semantic_cache alter column user_id   set not null;
alter table semantic_cache alter column llm_model set not null;

-- config_id: ownership -> provenance. Nullable, and never destructive.
alter table semantic_cache alter column config_id drop not null;
alter table semantic_cache drop constraint semantic_cache_config_id_fkey;
alter table semantic_cache
  add constraint semantic_cache_config_id_fkey
  foreign key (config_id) references configs(id) on delete set null;

-- Re-key. (The dropped constraint name is the real one read off the live DB —
-- note it is TRUNCATED: Postgres caps identifiers at 63 characters, so the name
-- generated from 0031's column list loses its `hash` and reads `..._query__key`,
-- not `..._query_hash_key`.)
alter table semantic_cache
  drop constraint semantic_cache_config_id_embedding_model_fingerprint_query__key;
alter table semantic_cache
  add constraint semantic_cache_user_key_uq
  unique (user_id, embedding_model, llm_model, fingerprint, query_hash);

drop index semantic_cache_lookup_idx;
create index semantic_cache_lookup_idx
  on semantic_cache (user_id, embedding_model, llm_model, fingerprint, created_at desc);

-- RLS. The 0051 policy authorized through `configs`; with config_id now nullable
-- that form denies every row whose originating config was deleted — silently,
-- per the README's "Adding a migration" warning. Replaced with the direct owner
-- form, which is what the new user_id column exists for.
drop policy rag_app_owner on semantic_cache;
create policy rag_app_owner on semantic_cache
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- NOT CHANGED: semantic_cache_shadow and semantic_cache_collision_floor stay
-- config-rooted. Shadow rows are calibration evidence about ONE config's
-- traffic, and the collision floor doesn't use the fingerprint at all. The
-- fingerprint value stamped on shadow rows changes meaning, which is fine — it
-- is an opaque grouping key there.
