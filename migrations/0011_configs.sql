-- ============================================================================
-- 0011_configs.sql
--
-- Configs: one saved experiment = one top-level tab. A config points at a corpus
-- and bundles the processing settings (embedding model, chunk size, overlap,
-- top-k, llm). All derived data (embedding runs, chunks, eval runs, cluster runs)
-- becomes owned by a config via config_id, so two configs over the SAME corpus
-- with different settings are a clean A/B (see docs/multi-config-plan.md §4).
--
-- Until now the "active config" was the single hard-coded lib/config.ts and the
-- derived data was keyed implicitly by the (model, chunk_size, chunk_overlap)
-- tuple. This migration:
--   1. creates `configs`,
--   2. adds config_id to document_embeddings / eval_runs / cluster_runs and
--      (denormalized, for filtered ANN) to the chunks_<model>_<dim> tables,
--   3. backfills a Default corpus + one Default config per distinct existing
--      settings tuple, and points all existing rows at it,
--   4. locks config_id NOT NULL where every row now has one.
--
-- eval_labels / eval_results / eval_question_embeddings / eval_model_trials /
-- eval_rankings need NO column: they reach a config transitively through
-- document_embedding_id. Their queries just swap the 3-tuple filter for a
-- de.config_id predicate.
-- ============================================================================

create table configs (
  id            uuid        primary key default gen_random_uuid(),
  corpus_id     uuid        not null references corpora(id) on delete restrict,
  name          text,                 -- null => UI renders a default label (settings + corpus + ts)
  base_model    text        not null,
  chunk_size    int         not null,
  chunk_overlap int         not null,
  top_k         int         not null,
  llm_model     text        not null,
  is_open       boolean     not null default true,   -- tab open/closed (reopen later)
  tab_order     int         not null default 0,      -- left-to-right tab order
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index configs_open_idx on configs (is_open, tab_order);

-- --- config_id on the derived tables --------------------------------------
alter table document_embeddings
  add column config_id uuid references configs(id) on delete cascade;
alter table eval_runs
  add column config_id uuid references configs(id) on delete cascade;
alter table cluster_runs
  add column config_id uuid references configs(id) on delete cascade;

-- Denormalized config_id on chunk rows so retrieval can do an indexed,
-- config-filtered ANN search (multiple configs now share each physical table).
-- Repeat the two statements for every chunks_<model>_<dim> table as more are
-- added (and update chunksTable() / EMBEDDING_DIMENSIONS in vectorStore.ts).
alter table chunks_voyage_4_lite_1024
  add column config_id uuid references configs(id) on delete cascade;

-- --- backfill -------------------------------------------------------------
-- 1. One corpus holding every existing document.
insert into corpora (name) values ('Default corpus');

insert into corpus_documents (corpus_id, document_id)
  select (select id from corpora order by created_at limit 1), id
  from documents;

-- 2. One config per DISTINCT existing (model, chunk_size, chunk_overlap) tuple
--    in document_embeddings, all over the default corpus. In practice there is
--    exactly one (only voyage-4-lite_1024 has a real chunk table), but looping
--    over distinct tuples keeps the backfill correct if more exist. top_k /
--    llm_model take the lib/config.ts defaults at the time of writing.
insert into configs (corpus_id, name, base_model, chunk_size, chunk_overlap, top_k, llm_model)
  select
    (select id from corpora order by created_at limit 1),
    'Default',
    de.model,
    de.chunk_size,
    de.chunk_overlap,
    5,
    'claude-sonnet-4-6'
  from (select distinct model, chunk_size, chunk_overlap from document_embeddings) de;

-- 3. Point existing derived rows at the matching config.
update document_embeddings de
  set config_id = c.id
  from configs c
  where de.model = c.base_model
    and de.chunk_size = c.chunk_size
    and de.chunk_overlap = c.chunk_overlap;

-- eval_runs snapshot the settings tuple directly — join on it.
update eval_runs er
  set config_id = c.id
  from configs c
  where er.model = c.base_model
    and er.chunk_size = c.chunk_size
    and er.chunk_overlap = c.chunk_overlap;

-- cluster_runs only record `model` (not size/overlap); attach to the config
-- with the matching base_model. With one config per model this is unambiguous.
update cluster_runs cr
  set config_id = c.id
  from configs c
  where cr.model = c.base_model;

-- 4. Denormalize config_id onto existing chunk rows via their embedding run.
update chunks_voyage_4_lite_1024 ch
  set config_id = de.config_id
  from document_embeddings de
  where de.id = ch.document_embedding_id;

-- --- replace the (model,size,overlap) uniqueness with a config-scoped one ---
-- The old unique (document_id, model, chunk_size, chunk_overlap) would block two
-- configs (e.g. a copy-on-write duplicate) from sharing identical settings over
-- the same doc. Drop it by definition (its generated name is truncated) and add
-- the config-scoped key.
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'document_embeddings'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (document_id, model, chunk_size, chunk_overlap)';
  if cname is not null then
    execute format('alter table document_embeddings drop constraint %I', cname);
  end if;
end $$;

alter table document_embeddings
  add constraint document_embeddings_config_doc_uq
  unique (config_id, document_id, model, chunk_size, chunk_overlap);

create index document_embeddings_config_idx2 on document_embeddings (config_id);
create index eval_runs_config_idx on eval_runs (config_id, created_at desc);
create index cluster_runs_config_idx on cluster_runs (config_id, saved, created_at desc);
create index chunks_voyage_4_lite_1024_config_idx on chunks_voyage_4_lite_1024 (config_id);

-- --- lock NOT NULL where every row now has a config ------------------------
alter table document_embeddings  alter column config_id set not null;
alter table chunks_voyage_4_lite_1024 alter column config_id set not null;
-- eval_runs / cluster_runs: left nullable. Pre-existing rows are backfilled, but
-- keeping them nullable avoids a failed migration if any orphan snapshot exists
-- whose settings tuple no longer maps to a config. New writes always set it.
