-- ============================================================================
-- 0004_eval_retrieved_scores.sql
--
-- Record the similarity score of each retrieved chunk at scoring time, so the
-- /eval drill-down can show HOW closely each top-k chunk matched the query (the
-- gap between rank-1 and the ground truth, how narrowly a distractor won, etc.).
--
-- Parallel array to eval_results.retrieved_ids — same length, same order, so
-- retrieved_scores[i] is the cosine similarity of retrieved_ids[i]. real[] (not
-- pgvector) because it's just stored and read back, never searched (same reasons
-- as the query-embedding cache in 0003). Nullable: rows scored before this
-- migration simply have no scores and render rank-only until re-scored.
-- ============================================================================

alter table eval_results
  add column retrieved_scores real[];
