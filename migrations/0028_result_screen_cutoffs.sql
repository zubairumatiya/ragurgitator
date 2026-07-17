-- ============================================================================
-- 0028_result_screen_cutoffs.sql
--
-- Similarity cutoffs captured at scoring time, so autotune's final re-score
-- can PROVE most questions unaffected by the run's override changes instead of
-- re-running retrieval for every question (the dirty-set re-score in
-- lib/rag/eval.rescoreAffectedQuestions). Shape (see retriever.ScreenCutoffs):
--
--   { "depth": <retrieval depth scored at>,
--     "deep":  <sim of the LAST candidate of the full deep base list, or null
--               when the corpus didn't fill it / the no-override fast path>,
--     "models": { "<model>": <depth-th strongest competitor sim in that
--                             model's space> } }
--
-- A changed chunk whose new pieces score below models[m] cannot enter the
-- merged top-depth; one whose base-space sim is below `deep` never competed in
-- the base lane at all. Combined with "was it in retrieved_ids", that bounds
-- every way an override change can ripple into a stored result.
--
-- NULL = scored before this migration (or under code that didn't capture
-- cutoffs); those rows simply can't be screened and re-score normally.
-- ============================================================================

alter table eval_results
  add column screen_cutoffs jsonb;
