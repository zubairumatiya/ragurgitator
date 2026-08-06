-- ============================================================================
-- 0020_embedding_cache.sql
--
-- Content-addressed embedding cache: one row per unique
-- (model, input_kind, sha256(text)) ever embedded. Backs lib/rag/embedCache's
-- persistent layer, so trial pools, delegate-space retrieval candidates, and
-- repeated queries cost one provider API call ever.
--
-- ⚠ SUPERSEDED IN PART BY 0050, which adds user_id to the primary key. Two
-- claims below were wrong and were acted on before that was noticed — corrected
-- in place so a fresh-database reader doesn't inherit them:
--
--   - "without retaining anyone's content" is FALSE as a security claim. No raw
--     text is stored, but the embedding is, and approximate reconstruction of
--     source text from a vector is a published attack.
--   - "lookups always arrive holding the text" was an invariant nothing
--     enforced, and it was already violated by replayStore's unqualified
--     count(*) — which made it a cross-tenant functional bug too.
--
-- Design decisions (see conversation with retriever option-1 fix):
--   - NO raw text: the hash is the key and the text is never needed again —
--     lookups always arrive holding the text. That keeps the table small; it
--     does NOT make it safe to share across tenants (see above).
--   - input_kind ('document' | 'query') is part of the key: Voyage/Cohere embed
--     the two differently (input_type), so a document vector must never be
--     served for a query lookup.
--   - One table for all models, real[] vector (mixed dimensions coexist): the
--     cache is only ever point-read by primary key, never vector-searched, so
--     the per-model chunks_* split (a pgvector fixed-dim/HNSW constraint)
--     doesn't apply. `model` leads the PK, so entries cluster per model anyway.
--   - Pure cache semantics: safe to truncate (everything re-embeds lazily),
--     and `delete where model = X` is the invalidation story if a provider
--     ever re-releases a model under the same id.
-- ============================================================================

create table embedding_cache (
  model      text        not null,             -- EMBEDDING_MODELS id
  input_kind text        not null,             -- 'document' | 'query'
  text_hash  text        not null,             -- sha256 hex of the exact input text
  dimension  int         not null,
  embedding  real[]      not null,
  created_at timestamptz not null default now(),
  primary key (model, input_kind, text_hash)
);

-- Delegate-space retrieval now ranks overridden chunks against the query's real
-- base-ANN candidates (retriever option 1) instead of only against each other,
-- so any config with overrides retrieves differently from here on — mark its
-- stored eval results stale (see 0019).
update configs c
set retrieval_changed_at = now()
where exists (
  select 1 from config_chunk_overrides o where o.config_id = c.id
);
