-- ============================================================================
-- 0031_semantic_cache.sql
--
-- Semantic answer cache: a near-duplicate of a past question serves that
-- question's stored answer, so ask() skips retrieval (and generation once it's
-- enabled). Backs lib/rag/semanticCache.ts. See docs/semantic-caching-plan.md.
--
-- Design decisions:
--   - Scoped to (config_id, embedding_model, fingerprint). config_id keeps one
--     config's answers from being served under another; embedding_model picks
--     the per-space threshold and guarantees query_vector is cosine-comparable
--     to the incoming query; fingerprint (semanticCacheCore.fingerprintFrom) is
--     the VALIDITY key — a hash of the config shape + corpus content + override
--     state, so any change makes old entries stop matching (and a later store
--     GCs them). A composite lookup index covers the hot read.
--   - query_vector is real[] (not pgvector): the cache is nearest-neighbour'd
--     in JS over a single config's small candidate set, never ANN-searched, so
--     it needs no fixed-dim/HNSW column and multiple model dims can coexist —
--     same rationale as embedding_cache (0020).
--   - result is the whole { answer, sources } jsonb blob served on a hit; the
--     sources already carry empty embeddings from the retriever, so rows stay
--     small. query_text is stored (the user's own question) to power a future
--     hits panel — unlike 0020, which is content-addressed and text-free.
--   - Pure cache semantics: safe to truncate (everything recomputes lazily);
--     the app tolerates this table not existing (42P01) and degrades to no-op.
-- ============================================================================

create table semantic_cache (
  id              uuid        primary key default gen_random_uuid(),
  config_id       uuid        not null references configs(id) on delete cascade,
  embedding_model text        not null,   -- base model that produced query_vector
  fingerprint     text        not null,   -- validity key (config shape + corpus + overrides)
  query_text      text        not null,   -- the past question (shown in the hits panel)
  query_hash      text        not null,   -- sha256(query_text), for exact-dup suppression
  query_vector    real[]      not null,   -- query embedding under embedding_model
  dimension       int         not null,
  result          jsonb       not null,   -- cached { answer, sources } served on a hit
  hit_count       int         not null default 0,
  created_at      timestamptz not null default now(),
  last_hit_at     timestamptz,
  unique (config_id, embedding_model, fingerprint, query_hash)
);

-- The hot path: candidates for one config+model valid under the current
-- fingerprint, newest first (the lookup caps how many it scores in JS).
create index semantic_cache_lookup_idx
  on semantic_cache (config_id, embedding_model, fingerprint, created_at desc);

-- Per vector-space cosine threshold: a match at or above `threshold` is a hit.
-- Keyed by embeddingModels.vectorSpace tag (or the model id when it has none),
-- because similarity scores aren't comparable across embedding models. Rows are
-- written by the Phase 2 calibration (or by hand); an absent space falls back to
-- config.semanticCache.defaultThreshold.
create table semantic_cache_thresholds (
  space         text        primary key,
  threshold     real        not null,
  calibrated_at timestamptz not null default now(),
  sample_size   int,                     -- eval-bank pairs used (null = hand-set)
  notes         text
);
