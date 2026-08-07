-- ============================================================================
-- 0053_document_embeddings_document_idx.sql
--
-- Supports the cross-config embedding reuse in vectorStore.reuseEmbeddingRun:
-- "does any OTHER config of this user already hold this document's vectors under
-- identical settings?"
--
-- Nothing indexed document_id before this. The three existing indexes all lead
-- with config_id or model, and the reuse lookup filters `config_id <> $active`
-- — an inequality, which cannot seek — so it degraded to a scan of every run
-- sharing the settings tuple. Invisible at three rows; quadratic during a corpus
-- sync, which calls it once per document against a table that grows with every
-- run written.
--
-- Leading with document_id is the point; the rest of the tuple lets the whole
-- predicate be satisfied from the index. `dimension` is left out deliberately —
-- it is functionally determined by `model`, so it would add a column to every
-- entry and discriminate nothing.
-- ============================================================================

create index if not exists document_embeddings_document_idx
  on document_embeddings (document_id, model, chunk_size, chunk_overlap);
