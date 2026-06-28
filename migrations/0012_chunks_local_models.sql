-- ============================================================================
-- 0012_chunks_local_models.sql
--
-- Tier B (real ingestion) vector tables for the two LOCAL embedding models, so a
-- config can be created with one of them as its base_model and A/B'd against
-- voyage-4-lite. Local models need no API key (transformers.js, in-process), so
-- they're the no-friction first non-Voyage ingestion targets — they just need a
-- place to store vectors. See docs/embedding-providers-plan.md §5 and
-- lib/rag/embeddingModels.ts (`ingestable: true`).
--
-- Same shape as chunks_voyage_4_lite_1024 in the POST-0011 form: a config-id
-- column (denormalized for filtered ANN, §5.3) + HNSW + doc/config indexes. Both
-- models output 1024-dim vectors. Table names match vectorStore.chunksTable()'s
-- derivation (id dashes → underscores, then the dim).
--
-- OpenAI / Cohere tables are intentionally NOT created here — add them on demand
-- once a key is present (a model with no key stays greyed in the picker anyway).
-- ============================================================================

create table chunks_mxbai_embed_large_1024 (
  id                    uuid         primary key default gen_random_uuid(),
  config_id             uuid         not null references configs(id)             on delete cascade,
  document_id           uuid         not null references documents(id)           on delete cascade,
  document_embedding_id uuid         not null references document_embeddings(id) on delete cascade,
  position              int          not null,
  text                  text         not null,
  embedding             vector(1024) not null
);
create index chunks_mxbai_embed_large_1024_hnsw
  on chunks_mxbai_embed_large_1024 using hnsw (embedding vector_cosine_ops);
create index chunks_mxbai_embed_large_1024_doc_idx
  on chunks_mxbai_embed_large_1024 (document_id);
create index chunks_mxbai_embed_large_1024_config_idx
  on chunks_mxbai_embed_large_1024 (config_id);

create table chunks_bge_m3_1024 (
  id                    uuid         primary key default gen_random_uuid(),
  config_id             uuid         not null references configs(id)             on delete cascade,
  document_id           uuid         not null references documents(id)           on delete cascade,
  document_embedding_id uuid         not null references document_embeddings(id) on delete cascade,
  position              int          not null,
  text                  text         not null,
  embedding             vector(1024) not null
);
create index chunks_bge_m3_1024_hnsw
  on chunks_bge_m3_1024 using hnsw (embedding vector_cosine_ops);
create index chunks_bge_m3_1024_doc_idx
  on chunks_bge_m3_1024 (document_id);
create index chunks_bge_m3_1024_config_idx
  on chunks_bge_m3_1024 (config_id);
