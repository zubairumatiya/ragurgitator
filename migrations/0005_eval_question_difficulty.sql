-- ============================================================================
-- 0005_eval_question_difficulty.sql
--
-- On-demand synthetic eval questions can now be generated at a target
-- difficulty (easy / medium / hard) — a dial on how far the question's wording
-- drifts from the passage's surface form, so retrieval is stress-tested with
-- harder, less lexically-overlapping queries (see lib/rag/eval.ts).
--
-- `difficulty` is null for hand-written ('manual') questions and for the bulk
-- "Process new chunks" generator, which uses the default prompt with no
-- difficulty modifier.
-- ============================================================================

alter table eval_questions
  add column difficulty text;  -- 'easy' | 'medium' | 'hard'; null = manual or default-generated
