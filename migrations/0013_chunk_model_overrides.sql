-- ============================================================================
-- 0013_chunk_model_overrides.sql
--
-- Per-chunk embedding-model OVERRIDE (multi-config-plan §4.3 option b, Phase 5).
-- A config's base model embeds all its chunks; the user can override a specific
-- chunk to a different model that retrieves it better (promoted from the
-- ephemeral "try a different model" experiment). The override is just an
-- ALTERNATE vector for a chunk that still lives in the base chunks_<model>_<dim>
-- table — so source_chunk_id has no FK (per-model chunk tables, like eval_labels)
-- and the chunk's text/position stay where they are.
--
-- Stored inline as real[] (not a pgvector column) because only a handful of
-- chunks are overridden per config: retrieval ranks the override side by a JS
-- full-scan cosine (lib/rag/retriever), while the base side keeps its indexed
-- HNSW ANN. At query time the two are fused by Reciprocal Rank Fusion (D7) — raw
-- cosine isn't comparable across embedding spaces. Cleared via the config_id
-- cascade when a config is deleted.
-- ============================================================================

create table config_chunk_overrides (
  config_id       uuid        not null references configs(id) on delete cascade,
  source_chunk_id uuid        not null,             -- chunk in the config's base table (no FK)
  model           text        not null,             -- override embedding model (EMBEDDING_MODELS id)
  dimension       int         not null,             -- the override embedding's dimension
  embedding       real[]      not null,             -- chunk text embedded under `model`
  created_at      timestamptz not null default now(),
  primary key (config_id, source_chunk_id)
);

-- "All overrides for this config under model M" — the per-model candidate set the
-- RRF fusion ranks.
create index config_chunk_overrides_model_idx
  on config_chunk_overrides (config_id, model);
