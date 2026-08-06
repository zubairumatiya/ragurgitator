-- ============================================================================
-- 0049_ownership.sql
--
-- Phase 2 of the user-accounts epic (docs/user-accounts-plan.md): the migration
-- that actually makes the app multi-tenant. 0046 added identity (user_profiles);
-- this adds ownership.
--
-- Three root tables get a user_id. Everything else reaches an owner transitively
-- and needs no column — the same reasoning 0011 used for the eval tables:
--
--   configs.user_id    <- cluster_runs, eval_runs, document_embeddings,
--                         semantic_cache, config_chunk_overrides, autotune_runs,
--                         replay_metrics, chunks_* … (17 tables carry config_id)
--   documents.user_id  <- eval_questions.document_id
--                           <- eval_rankings.eval_question_id
--   corpora.user_id    <- corpus_documents.corpus_id
--
-- Note eval_questions / eval_rankings / eval_model_trials have NO config_id (see
-- 0011's header) — they reach an owner through documents and document_embeddings
-- respectively. That is why the store-layer authorization predicates for those
-- tables are joins rather than a uniform config_id filter.
--
-- batch_jobs also gets a user_id, but see the note below: it is deliberately
-- nullable, unlike the other three.
--
-- Backfill mirrors 0011: point every existing row at the first owner, then lock
-- NOT NULL. The owner's user_profiles row must already exist, which 0046's
-- trigger guarantees for anyone who has signed up.
-- ============================================================================

-- --- ownership columns ------------------------------------------------------
alter table corpora   add column user_id uuid references user_profiles(id) on delete cascade;
alter table configs   add column user_id uuid references user_profiles(id) on delete cascade;
alter table documents add column user_id uuid references user_profiles(id) on delete cascade;

-- batch_jobs.config_id is `on delete set null` (0029), so a job whose config was
-- deleted has no path to an owner. Rather than fabricate one, this column stays
-- NULLABLE and the poller treats null as "not mine" — an orphaned historical job
-- is simply never advanced again. New submits always set it.
alter table batch_jobs add column user_id uuid references user_profiles(id) on delete cascade;

-- --- backfill ---------------------------------------------------------------
-- The first owner, by signup order. Single-tenant today (1 profile, 2 corpora,
-- 2 configs, 3 documents), so this is unambiguous. Fails loudly on a database
-- with no profile at all, which is the correct outcome: NOT NULL below could not
-- be satisfied anyway, and silently creating an owner here would be worse.
do $$
declare owner_id uuid;
begin
  select id into owner_id from user_profiles order by created_at limit 1;
  if owner_id is null then
    raise exception
      'No user_profiles row to own existing data. Sign up the first account before applying 0049.';
  end if;

  update corpora    set user_id = owner_id where user_id is null;
  update configs    set user_id = owner_id where user_id is null;
  update documents  set user_id = owner_id where user_id is null;
  update batch_jobs set user_id = owner_id where user_id is null;
end $$;

-- --- lock NOT NULL on the three roots ---------------------------------------
alter table corpora   alter column user_id set not null;
alter table configs   alter column user_id set not null;
alter table documents alter column user_id set not null;

-- --- per-user document dedup ------------------------------------------------
-- content_hash was globally unique, which under multi-tenancy is three problems
-- at once: two users uploading the same PDF collide outright, the second one
-- silently inherits the first's document, and "has anyone uploaded this file"
-- becomes an existence oracle. Cross-user dedup is also a cost transfer — one
-- user pays to ingest, another reads it free.
alter table documents drop constraint documents_content_hash_key;
alter table documents add constraint documents_user_hash_uq unique (user_id, content_hash);

-- --- indexes ----------------------------------------------------------------
-- Every list query gains a user_id predicate, so each root table needs one.
-- documents is covered by documents_user_hash_uq's leading column.
create index corpora_user_idx    on corpora    (user_id);
create index configs_user_idx    on configs    (user_id);
create index batch_jobs_user_idx on batch_jobs (user_id, created_at desc);
