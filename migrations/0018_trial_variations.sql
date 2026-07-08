-- ============================================================================
-- 0018_trial_variations.sql
--
-- "Try a different configuration": the per-chunk trial can now vary the chunk's
-- SIZE (re-split at size/overlap or custom drag-border sections) and COMBINE a
-- size with an alternate model, not just swap the model. Existing rows are all
-- model-only trials, so the new kind column defaults to 'model'.
--
--   kind          'model' | 'size' | 'size+model'
--   chunk_size    uniform re-split size in tokens (null = custom sections or model-only)
--   chunk_overlap uniform re-split overlap in tokens (same nullability)
--   piece_count   how many pieces the chunk was split into (null for model-only)
-- ============================================================================

alter table eval_model_trials
  add column kind          text not null default 'model',
  add column chunk_size    int,
  add column chunk_overlap int,
  add column piece_count   int;
