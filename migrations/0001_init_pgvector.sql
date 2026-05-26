-- ============================================================================
-- 0001_init_pgvector.sql
--
-- Initial schema:
--   - documents             one row per unique document (keyed by content_hash)
--   - document_embeddings   registry: which (model, chunk_size, overlap) configs
--                           has each document been processed under?
--   - chunks_<model>_<dim>  one chunks table per (embedding-model, dimension).
--                           Vectors from different models live in different
--                           geometric spaces and pgvector enforces a fixed dim
--                           per column, so separation makes both correctness
--                           and indexing cleaner.
--
-- To support a new embedding model later: add a 0002_… migration that creates
-- a new `chunks_<model>_<dim>` table + HNSW index. The application's
-- `chunksTable(model, dim)` mapping picks the right one at runtime.
-- ============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

create table documents (
  id           uuid        primary key default gen_random_uuid(),
  file_name    text        not null,
  content_hash text        not null unique,
  created_at   timestamptz not null default now()
);

create table document_embeddings (
  id            uuid        primary key default gen_random_uuid(),
  document_id   uuid        not null references documents(id) on delete cascade,
  model         text        not null,
  dimension     int         not null,
  chunk_size    int         not null,
  chunk_overlap int         not null,
  chunk_count   int         not null,
  created_at    timestamptz not null default now(),
  unique (document_id, model, chunk_size, chunk_overlap)
);

create index document_embeddings_config_idx
  on document_embeddings (model, chunk_size, chunk_overlap, created_at desc);

create table chunks_voyage_4_lite_1024 (
  id                    uuid         primary key default gen_random_uuid(),
  document_id           uuid         not null references documents(id) on delete cascade,
  document_embedding_id uuid         not null references document_embeddings(id) on delete cascade,
  position              int          not null,
  text                  text         not null,
  embedding             vector(1024) not null
);

create index chunks_voyage_4_lite_1024_hnsw
  on chunks_voyage_4_lite_1024
  using hnsw (embedding vector_cosine_ops);

create index chunks_voyage_4_lite_1024_doc_idx
  on chunks_voyage_4_lite_1024 (document_id);
