-- ============================================================================
-- 0017_corpus_decouple.sql
--
-- Decouple configs from corpora. A corpus is a reusable selection of documents
-- (a quick way to pick a doc set when creating a config); a config's ACTUAL
-- document set is its per-config embedding runs (document_embeddings), which
-- already live independently. So:
--
--   - configs.corpus_id becomes NULLABLE and ON DELETE SET NULL (was NOT NULL
--     + RESTRICT): deleting a corpus leaves its configs — and their embedded
--     docs — fully intact; the pointer just clears.
--   - configs.corpus_sync: the auto-sync toggle. When true (and corpus_id is
--     set), membership changes flow both ways: docs uploaded in the config
--     join the corpus, and docs added to / removed from the corpus are
--     embedded into / removed from the config. When false the config ignores
--     corpus edits and its uploads stay out of any corpus.
--
-- Backfill: existing configs keep corpus_sync = true — that matches today's
-- coupled behaviour (config uploads always joined their corpus).
-- ============================================================================

alter table configs alter column corpus_id drop not null;

alter table configs drop constraint configs_corpus_id_fkey;
alter table configs
  add constraint configs_corpus_id_fkey
  foreign key (corpus_id) references corpora(id) on delete set null;

alter table configs
  add column corpus_sync boolean not null default true;
