-- ============================================================================
-- 0033_cluster_topup.sql
--
-- INCREMENTAL BUCKET TOP-UP for saved cluster presets (lib/rag/clusterStore
-- .topUpSavedRuns). Chunks ingested after a preset was fit had no bucket at
-- all, so /eval's bulk nDCG grader SKIPPED their questions — new documents were
-- silently excluded from the nDCG aggregate until someone re-ran clustering by
-- hand. Top-up assigns each newly ingested chunk to its nearest EXISTING
-- centroid, so those questions become gradeable immediately.
--
-- The centroid is deliberately NOT recomputed. Moving it would change what
-- nearestBuckets() returns for questions that are already graded, so rebuilding
-- an old ranking would silently draw a different pool. Frozen centroids keep
-- past rankings reproducible — at the cost of the centroid no longer being the
-- true mean of its members, which is exactly what this column measures.
--
--   topped_up_at   null = assigned by the original k-means fit
--                  set  = bolted on afterwards, against a frozen centroid
--
-- cluster_runs.chunk_count and clusters.size stay untouched: per 0008 those are
-- FROZEN aggregates describing the fit, and the fit did not change. Current
-- membership is chunk_clusters; the gap between the two IS the drift, surfaced
-- as ClusterRunSummary.driftRatio and flagged past config.clusterDriftThreshold.
-- Re-running clustering remains the only thing that restores a true fit.
-- ============================================================================
alter table chunk_clusters
  add column topped_up_at timestamptz;

-- Drift is read per-run on every /eval + /clusters load ("how many of this
-- run's rows were bolted on"), and only topped-up rows are ever counted — a
-- partial index keeps it off the (much larger) original-fit rows.
create index chunk_clusters_topped_up_idx
  on chunk_clusters (cluster_run_id)
  where topped_up_at is not null;
