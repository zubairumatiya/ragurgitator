-- ============================================================================
-- 0076_eval_runs_ndcg_covered.sql
--
-- How many questions the nDCG on a run snapshot was actually measured over
-- (docs/demo-analytics-plan.md, phase 3).
--
-- WHY. `eval_runs.ndcg` has always been a mean over the GRADED questions only —
-- the ones with an is_truth eval_rankings row (0009) — while `question_count`
-- next to it counts every scored question. On the master those two are close
-- enough that nobody noticed the gap. On the published demo they are 12 and 472,
-- because phase 3 clones a truth ranking for twelve questions and no more: the
-- drilldown is the part a visitor can drive, and copying 472 of them costs 1.26 MB
-- to grade questions nobody can tune.
--
-- A card reading "nDCG@5 0.61" over a header saying "472 questions" is the same
-- class of mistake this plan's phase 2 was written to fix. So the denominator
-- becomes a stored fact rather than something the UI guesses.
--
-- Nullable, and null on every existing row: those runs were taken before the
-- count was recorded, and a backfill would have to invent it — today's truth
-- rankings are not the ones a run from March graded against. Null renders as no
-- caption, which is the honest reading of "we do not know".
-- ============================================================================

alter table eval_runs
  add column ndcg_covered integer;

comment on column eval_runs.ndcg_covered is
  'Questions the ndcg mean covers (those with an is_truth ranking at run time). '
  'Null for rows written before 0076. Always <= question_count.';
