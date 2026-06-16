-- ============================================================================
-- 0008_clusters.sql
--
-- K-means clustering of the corpus embeddings, for the /clusters page. We group
-- the chunks of the active (model, dim) corpus into k buckets and record how
-- tight each bucket is, so the UI can show per-bucket cohesion + a run-level
-- silhouette and compare different k.
--
--   - cluster_runs    one k-means run (a given k + random seed). Most runs are
--                     transient candidates (saved=false); the ones the user
--                     keeps become named presets (saved=true). Transient runs are
--                     pruned when the next run starts (see clusterStore).
--   - clusters        one bucket: its centroid + size + cohesion (and a label
--                     slot for the future Claude-naming step).
--   - chunk_clusters  chunk -> bucket assignment, with the chunk's cosine
--                     similarity to its centroid. The (cluster_id, similarity)
--                     index makes "all chunks in this bucket, nearest first" an
--                     indexed lookup — the relational form of an IVF inverted list.
--
-- Like eval_model_trials, runs are FROZEN aggregates — never recomputed in place.
-- chunk_id has no FK (chunks live in per-model chunks_<model>_<dim> tables, same
-- as eval_labels); cleanup is transitive via the cluster_runs cascade.
-- ============================================================================

create table cluster_runs (
  id           uuid        primary key default gen_random_uuid(),
  model        text        not null,
  dimension    int         not null,
  k            int         not null,
  seed         bigint      not null,                 -- reproduces this candidate
  chunk_count  int         not null,
  inertia      float8      not null,                 -- sum of squared dist to centroid
  avg_cohesion float8      not null,                 -- size-weighted mean cohesion
  silhouette   float8      not null,                 -- run-level, centroid approximation
  saved        boolean     not null default false,   -- true once kept as a preset
  name         text,                                 -- preset name (when saved)
  created_at   timestamptz not null default now()
);

create index cluster_runs_saved_idx on cluster_runs (saved, created_at desc);

create table clusters (
  id             uuid         primary key default gen_random_uuid(),
  cluster_run_id uuid         not null references cluster_runs(id) on delete cascade,
  ordinal        int          not null,              -- 0..k-1, stable display order
  centroid       vector(1024) not null,
  size           int          not null,
  cohesion       float8       not null,              -- mean cosine sim of members to centroid
  label          text                                -- null until the Claude-naming step
);

create index clusters_run_idx on clusters (cluster_run_id, ordinal);

create table chunk_clusters (
  cluster_run_id uuid  not null references cluster_runs(id) on delete cascade,
  chunk_id       uuid  not null,                     -- no FK (per-model chunks table)
  cluster_id     uuid  not null references clusters(id) on delete cascade,
  similarity     real  not null,                     -- cosine sim to its centroid
  primary key (cluster_run_id, chunk_id)
);

-- "All chunks in bucket X, nearest-to-centroid first" — indexed range scan.
create index chunk_clusters_cluster_idx on chunk_clusters (cluster_id, similarity desc);
