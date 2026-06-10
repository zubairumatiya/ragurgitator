-- Freeze MRR and nDCG@k into run snapshots alongside the existing hit_count
-- (recall). Both are aggregates over the same fresh-scored question set recall
-- uses, computed from found_rank at snapshot time (see lib/rag/evalMetrics.ts).
-- Nullable: rows created before this migration have no value and render as "—".
alter table eval_runs
  add column mrr  real,
  add column ndcg real;
