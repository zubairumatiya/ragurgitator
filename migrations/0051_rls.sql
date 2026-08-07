-- ============================================================================
-- 0051_rls.sql
--
-- Phase 5b of the user-accounts epic (docs/user-accounts-plan.md §7). 0049 and
-- 0050 made every row reachable to exactly one owner and made the STORE LAYER
-- filter by it. This makes the DATABASE enforce it, so a store call that forgets
-- its predicate returns nothing instead of returning everyone's rows.
--
-- It is defence in depth, not a replacement for the predicates. Anyone who can
-- dump the table still gets every tenant's rows; what this buys is that a single
-- missing `where user_id = …` stops being a cross-tenant read.
--
-- THE STARTING STATE IS NOT "RLS OFF". All 39 tables in `public` already have
-- relrowsecurity = true with zero policies — Supabase's default, which denies
-- everything to any role that doesn't bypass. It has been inert only because
-- DATABASE_URL connects as `postgres`, and `postgres` has rolbypassrls = true.
-- So this migration does not enable RLS; it creates the role that cannot bypass
-- it, grants that role what the app needs, and writes the policies. `alter table
-- … force row level security` would NOT have helped: BYPASSRLS beats FORCE.
--
--   1. role `rag_app` — login, NOBYPASSRLS, granted DML on public
--   2. schema `app` + app.current_user_id(), the identity every policy reads
--   3. policies, one per table, all `to rag_app`
--
-- Applying this alone changes nothing: the app keeps connecting as `postgres`
-- until RAG_APP_DATABASE_URL is set (see README). That is deliberate — the
-- migration and the connection switch can be reverted independently.
-- ============================================================================

-- --- 1. the restricted role --------------------------------------------------
-- NOBYPASSRLS is the whole point. LOGIN because the app connects as it directly
-- through Supavisor on 6543 (verified: the pooler accepts the username form
-- `rag_app.<project-ref>`).
--
-- NO PASSWORD IS SET HERE. A migration file is committed; a password is not.
-- Set one out of band and put the resulting URL in RAG_APP_DATABASE_URL:
--
--   alter role rag_app password '…';
--
-- `postgres` deliberately keeps its own pool (lib/db.ts privilegedSql) for the
-- two things rag_app must never be able to do: delete auth.users rows, which is
-- how account deletion avoids needing a permanent service-role key in env, and
-- run migrations. Do not grant either to rag_app.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rag_app') then
    create role rag_app login nobypassrls;
  else
    alter role rag_app login nobypassrls;
  end if;
end $$;

-- --- 2. identity -------------------------------------------------------------
-- Deliberately NOT in `public`: Supabase exposes public functions as PostgREST
-- RPC, and nothing about the app's session identity belongs on a URL. `app` is
-- not in the exposed schema list, so the function is reachable only from SQL.
create schema if not exists app;

-- STABLE, not VOLATILE: that is what lets the planner evaluate it ONCE per query
-- instead of once per row, which is the difference between a policy that is free
-- on a vector scan and one that is not.
--
-- The nullif is not defensive tidiness, it is required. On a pooled connection
-- that has previously run `set local app.user_id`, current_setting(…, true)
-- returns the EMPTY STRING rather than NULL once the transaction ends, and
-- ''::uuid raises `invalid input syntax for type uuid` — so the naive expression
-- ERRORS where it is supposed to DENY. Measured against this database, not
-- assumed.
create or replace function app.current_user_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

grant usage on schema app to rag_app;
grant execute on function app.current_user_id() to rag_app;

grant usage on schema public to rag_app;
grant select, insert, update, delete on all tables in schema public to rag_app;
grant usage, select on all sequences in schema public to rag_app;

-- Without this, the next migration that creates a table produces one rag_app
-- cannot touch at all, and the failure surfaces as a permission error in prod
-- rather than at review time.
alter default privileges in schema public
  grant select, insert, update, delete on tables to rag_app;
alter default privileges in schema public
  grant usage, select on sequences to rag_app;

-- ⚠ GRANTS ARE ONLY HALF OF IT. The event trigger `ensure_rls` (function
-- public.rls_auto_enable, SECURITY DEFINER, created out of band and present in
-- no migration) enables RLS on every new table in `public` automatically. A new
-- table therefore arrives grantable but POLICY-LESS, which under rag_app is
-- deny-all — an outage the moment code touches it. Every future migration that
-- creates a table must add its policy here too.

-- --- 3. policies -------------------------------------------------------------
-- All `to rag_app`, never the default `to public`. `anon` and `authenticated`
-- hold full DML grants on every one of these tables (Supabase's default), and
-- the ONLY thing keeping the browser-exposed publishable key from reading them
-- is that they currently have no policies at all. A policy without a role clause
-- would apply to anon as well; it would still deny today, for the incidental
-- reason that anon has no app.user_id GUC, but that is one refactor away from a
-- full public read.
--
-- `for all … using … with check`: `using` governs SELECT/UPDATE/DELETE and
-- `with check` governs INSERT/UPDATE. Omitting the latter makes every insert
-- fail, which is a slower way to find the same bug.
--
-- Chains are ONE level deep on purpose. RLS applies to tables referenced inside
-- a policy expression too, so `eval_labels -> eval_questions` is transitively
-- restricted by eval_questions' own policy reaching documents.user_id. Spelling
-- the full chain out at every leaf would duplicate the graph and let the copies
-- drift.

-- 3a. the roots — a user_id column of their own.
create policy rag_app_owner on configs
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy rag_app_owner on corpora
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy rag_app_owner on documents
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy rag_app_owner on embedding_cache
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy rag_app_owner on semantic_cache_thresholds
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

create policy rag_app_owner on user_provider_keys
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- batch_jobs.user_id is nullable (0 rows today). A NULL owner is an orphaned job
-- no session can claim, and deny-all is the right answer for it.
create policy rag_app_owner on batch_jobs
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- user_profiles keys the user on `id`, not `user_id`.
create policy rag_app_owner on user_profiles
  for all to rag_app
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- 3b. config-scoped — reachable through configs.user_id, which 3a restricts.
create policy rag_app_owner on autotune_runs
  for all to rag_app
  using (exists (select 1 from configs c where c.id = autotune_runs.config_id))
  with check (exists (select 1 from configs c where c.id = autotune_runs.config_id));

create policy rag_app_owner on chunks_bge_m3_1024
  for all to rag_app
  using (exists (select 1 from configs c where c.id = chunks_bge_m3_1024.config_id))
  with check (exists (select 1 from configs c where c.id = chunks_bge_m3_1024.config_id));

create policy rag_app_owner on chunks_mxbai_embed_large_1024
  for all to rag_app
  using (exists (select 1 from configs c where c.id = chunks_mxbai_embed_large_1024.config_id))
  with check (exists (select 1 from configs c where c.id = chunks_mxbai_embed_large_1024.config_id));

create policy rag_app_owner on chunks_voyage_4_lite_1024
  for all to rag_app
  using (exists (select 1 from configs c where c.id = chunks_voyage_4_lite_1024.config_id))
  with check (exists (select 1 from configs c where c.id = chunks_voyage_4_lite_1024.config_id));

create policy rag_app_owner on cluster_runs
  for all to rag_app
  using (exists (select 1 from configs c where c.id = cluster_runs.config_id))
  with check (exists (select 1 from configs c where c.id = cluster_runs.config_id));

create policy rag_app_owner on config_chunk_overrides
  for all to rag_app
  using (exists (select 1 from configs c where c.id = config_chunk_overrides.config_id))
  with check (exists (select 1 from configs c where c.id = config_chunk_overrides.config_id));

create policy rag_app_owner on config_question_ignores
  for all to rag_app
  using (exists (select 1 from configs c where c.id = config_question_ignores.config_id))
  with check (exists (select 1 from configs c where c.id = config_question_ignores.config_id));

create policy rag_app_owner on config_retrieval_changes
  for all to rag_app
  using (exists (select 1 from configs c where c.id = config_retrieval_changes.config_id))
  with check (exists (select 1 from configs c where c.id = config_retrieval_changes.config_id));

create policy rag_app_owner on document_embeddings
  for all to rag_app
  using (exists (select 1 from configs c where c.id = document_embeddings.config_id))
  with check (exists (select 1 from configs c where c.id = document_embeddings.config_id));

create policy rag_app_owner on eval_runs
  for all to rag_app
  using (exists (select 1 from configs c where c.id = eval_runs.config_id))
  with check (exists (select 1 from configs c where c.id = eval_runs.config_id));

create policy rag_app_owner on replay_metrics
  for all to rag_app
  using (exists (select 1 from configs c where c.id = replay_metrics.config_id))
  with check (exists (select 1 from configs c where c.id = replay_metrics.config_id));

create policy rag_app_owner on savings_totals
  for all to rag_app
  using (exists (select 1 from configs c where c.id = savings_totals.config_id))
  with check (exists (select 1 from configs c where c.id = savings_totals.config_id));

create policy rag_app_owner on semantic_cache
  for all to rag_app
  using (exists (select 1 from configs c where c.id = semantic_cache.config_id))
  with check (exists (select 1 from configs c where c.id = semantic_cache.config_id));

create policy rag_app_owner on semantic_cache_collision_floor
  for all to rag_app
  using (exists (select 1 from configs c where c.id = semantic_cache_collision_floor.config_id))
  with check (exists (select 1 from configs c where c.id = semantic_cache_collision_floor.config_id));

create policy rag_app_owner on semantic_cache_shadow
  for all to rag_app
  using (exists (select 1 from configs c where c.id = semantic_cache_shadow.config_id))
  with check (exists (select 1 from configs c where c.id = semantic_cache_shadow.config_id));

create policy rag_app_owner on spend_totals
  for all to rag_app
  using (exists (select 1 from configs c where c.id = spend_totals.config_id))
  with check (exists (select 1 from configs c where c.id = spend_totals.config_id));

-- 3c. the second root's tree — eval_questions hangs off documents.user_id, not
-- off a config, exactly as 0049 found. Every FK below is NOT NULL and holds zero
-- NULLs on the live database, so nothing becomes invisible.
create policy rag_app_owner on eval_questions
  for all to rag_app
  using (exists (select 1 from documents d where d.id = eval_questions.document_id))
  with check (exists (select 1 from documents d where d.id = eval_questions.document_id));

create policy rag_app_owner on eval_question_embeddings
  for all to rag_app
  using (exists (select 1 from eval_questions q where q.id = eval_question_embeddings.eval_question_id))
  with check (exists (select 1 from eval_questions q where q.id = eval_question_embeddings.eval_question_id));

create policy rag_app_owner on eval_labels
  for all to rag_app
  using (exists (select 1 from eval_questions q where q.id = eval_labels.eval_question_id))
  with check (exists (select 1 from eval_questions q where q.id = eval_labels.eval_question_id));

create policy rag_app_owner on eval_rankings
  for all to rag_app
  using (exists (select 1 from eval_questions q where q.id = eval_rankings.eval_question_id))
  with check (exists (select 1 from eval_questions q where q.id = eval_rankings.eval_question_id));

create policy rag_app_owner on eval_results
  for all to rag_app
  using (exists (select 1 from eval_questions q where q.id = eval_results.eval_question_id))
  with check (exists (select 1 from eval_questions q where q.id = eval_results.eval_question_id));

create policy rag_app_owner on semantic_cache_pairs
  for all to rag_app
  using (exists (select 1 from eval_questions q where q.id = semantic_cache_pairs.origin_question_id))
  with check (exists (select 1 from eval_questions q where q.id = semantic_cache_pairs.origin_question_id));

create policy rag_app_owner on autotune_question_outcomes
  for all to rag_app
  using (exists (select 1 from autotune_runs r where r.id = autotune_question_outcomes.autotune_run_id))
  with check (exists (select 1 from autotune_runs r where r.id = autotune_question_outcomes.autotune_run_id));

create policy rag_app_owner on eval_model_trials
  for all to rag_app
  using (exists (select 1 from document_embeddings e where e.id = eval_model_trials.document_embedding_id))
  with check (exists (select 1 from document_embeddings e where e.id = eval_model_trials.document_embedding_id));

-- 3d. the rest of the graph.
create policy rag_app_owner on corpus_documents
  for all to rag_app
  using (exists (select 1 from corpora c where c.id = corpus_documents.corpus_id))
  with check (exists (select 1 from corpora c where c.id = corpus_documents.corpus_id));

create policy rag_app_owner on clusters
  for all to rag_app
  using (exists (select 1 from cluster_runs r where r.id = clusters.cluster_run_id))
  with check (exists (select 1 from cluster_runs r where r.id = clusters.cluster_run_id));

create policy rag_app_owner on chunk_clusters
  for all to rag_app
  using (exists (select 1 from cluster_runs r where r.id = chunk_clusters.cluster_run_id))
  with check (exists (select 1 from cluster_runs r where r.id = chunk_clusters.cluster_run_id));

-- --- 4. deliberately policy-less --------------------------------------------
-- topics, topic_specimens, topic_centroids and chunk_topics get NO policy, so
-- rag_app cannot read or write them at all. That is intended, not an omission.
--
-- They exist only on the live database: no migration creates them and nothing on
-- this branch reads them. They came from the `sub-topics` branch's specimen
-- pipeline, and they have no ownership path of any kind — `topics` is keyed by
-- slug alone and `chunk_topics` by text_hash, the same content-addressed
-- cross-tenant shape 0050 had to fix for embedding_cache.
--
-- This is also why Phase 5's claim that its key sweep was "exhaustive" was not:
-- it swept migrations 0001-0049, so four tables that exist only in the database
-- were invisible to it. When sub-topics lands it must bring both a migration and
-- an owner, and then a policy belongs here.
-- ============================================================================
