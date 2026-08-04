-- ============================================================================
-- 0044_replay_ndcg.sql
--
-- Adds graded nDCG to the offline replay (0043). The replay already ranks the
-- full corpus per model; eval_rankings (0009) already holds a graded ideal order
-- per question. Scoring one against the other needs no new data and no embedding
-- calls — the same lib/rag/evalMetrics.ndcg the live eval uses.
--
-- WHY IT'S NOT JUST ANOTHER COLUMN: the stored ideal is an AGGREGATE of several
-- embedding models' rankings (lib/config.rankingAggregateModels — currently
-- voyage-4-lite, voyage-4-large, voyage-4, voyage-code-3). Grading one of those
-- four against it is circular: the model helped define its own target. So the
-- replay rebuilds the ideal per model, averaging only the OTHER contributors'
-- ranks (eval_rankings.details.perModelRanks) before scoring — see
-- replayMetrics.leaveOneOutIdeal. `ndcg_leave_one_out` records whether that
-- correction actually applied to this row, because it changes what the number
-- means and a reader deserves to see which models needed it.
--
--   ndcg     — nDCG@k against the (possibly corrected) ideal; null when the
--              question set has no graded ranking, matching evalMetrics.ndcg's
--              "ungraded" contract rather than a misleading 0.
--   ndcg_k   — the k it was computed at (the config's top_k), so a later change
--              to k is visible rather than silently comparing different depths.
-- ============================================================================

alter table replay_metrics
  add column ndcg                numeric,
  add column ndcg_k              int,
  add column ndcg_leave_one_out  boolean not null default false;
