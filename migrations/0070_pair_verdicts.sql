-- ============================================================================
-- 0070_pair_verdicts.sql
--
-- Follow-up F3 (docs/resume-metrics-f3-f4-plan.md). Somewhere to record whether
-- a GENERATED pair's constructed label is actually right.
--
-- WHY. Every row in semantic_cache_pairs was written by claude-haiku-4-5 and no
-- human has ever checked one. pooledPairs() feeds them straight into the
-- key-model sweep, so every key-model conclusion inherits whatever error rate is
-- in there — and the two runs that measured that rate on the rows a judge
-- disputed found the GENERATOR wrong more often than the judge (F1: 8 of 12,
-- F2: 2 of 3). The table had nowhere to put a verdict, so the sweep had no way
-- to stop consuming a row known to be mislabelled.
--
-- The columns mirror semantic_cache_shadow's (0035:38-42) name for name, so the
-- two verdict surfaces read alike and the same adjudication vocabulary applies:
-- an 'llm' verdict is evidence, a 'human' verdict is truth, and a human verdict
-- is never overwritten by a later pass.
--
-- One deliberate difference: shadow calls it judge_source, this calls it
-- verdict_source. The shadow column is named for WHO JUDGED; here the value is
-- the FINAL LABEL's provenance, which for an adjudicated row is a human who
-- overruled the judge rather than a human who judged. Same domain, different
-- claim.
--
-- RLS: semantic_cache_pairs already carries `rag_app_owner` (0051:275), which
-- reaches tenancy through eval_questions.origin_question_id and is FOR ALL over
-- the row — it is not column-scoped, so it covers these columns unchanged. The
-- rag_app grants are likewise table-level (0051:85), not per-column. Both were
-- confirmed against 0051 rather than assumed, per the new-migration policy
-- checklist.
--
-- Still pure cache semantics: safe to truncate, and a verdict is re-derivable by
-- re-running `npm run f3 -- judge` (the hand adjudications are not, which is why
-- they also live in docs/resume-metrics-f3-adjudications.json).
-- ============================================================================

alter table semantic_cache_pairs
  add column verdict        text check (verdict in ('accept', 'reject')),
  add column verdict_source text check (verdict_source in ('llm', 'human')),
  add column judge_model    text,
  add column judge_reason   text,
  add column judged_at      timestamptz;

-- The judge pass is resumable — it scans for rows that have no verdict yet — and
-- listPairs now filters on verdict on every sweep read. Partial on the unjudged
-- side because that set shrinks to empty as a run completes, while the read path
-- wants the whole table anyway.
create index semantic_cache_pairs_unjudged_idx
  on semantic_cache_pairs (origin_question_id)
  where verdict is null;
