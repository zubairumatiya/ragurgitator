-- ============================================================================
-- 0023_mrr_criteria.sql
--
-- Promote MRR to a first-class eval metric alongside Recall and nDCG. The
-- aggregate has been computed and snapshotted since 0007 (eval_runs.mrr); this
-- adds the per-config criteria that gate its display, its own depth (MRR@k —
-- a rank beyond k contributes 0 instead of 1/rank), and an optional min-rate
-- that makes it an autotune target like the other two (0014's A1 shape).
--
-- Enabled by default: additive for existing configs, which have been computing
-- MRR all along — this just surfaces it.
-- ============================================================================

alter table configs
  add column mrr_enabled  boolean not null default true,
  add column mrr_k        int,   -- null => fall back to top_k
  add column mrr_min_rate real;  -- null => metric runs but no autotune target

-- Run history: record the MRR bar a run targeted, like recall/ndcg (0016).
alter table autotune_runs
  add column mrr_k        int,
  add column mrr_min_rate real;
