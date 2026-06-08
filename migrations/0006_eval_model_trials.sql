-- ============================================================================
-- 0006_eval_model_trials.sql
--
-- Saved snapshots of the per-chunk "try a different model" experiment (see
-- lib/rag/eval.runModelTrial). For one labeled chunk we re-embed a small
-- CANDIDATE POOL — the chunk itself plus the top-k chunks its questions
-- retrieved (and any corpus chunks the user hand-picked) — under an alternate
-- embedding model, then re-rank each question within that pool. The experiment
-- is ephemeral by default; this table only holds the runs the user chose to
-- KEEP, so the /eval chunk can show "models tried" over time.
--
-- Like eval_runs, a row is a FROZEN aggregate — we never recompute it. It is NOT
-- a live score: the new-model rank is within the candidate pool, not the full
-- corpus, and the baseline columns are the question's stored full-corpus result
-- at save time. Raw vectors are intentionally NOT stored (the pool is tiny and
-- re-embedding is cheap; a stored vector would also go stale on any text edit) —
-- only the outcome, which is the lasting artifact.
--
-- source_chunk_id has no FK (chunks live in per-model chunks_<model>_<dim>
-- tables, same as eval_labels); cleanup is transitive via document_embedding_id,
-- which cascades when the document/embedding-run is deleted.
-- ============================================================================

create table eval_model_trials (
  id                    uuid        primary key default gen_random_uuid(),
  source_chunk_id       uuid        not null,                  -- the chunk under test
  document_embedding_id uuid        not null references document_embeddings(id) on delete cascade,
  baseline_model        text        not null,                 -- model the stored full-corpus result used
  trial_model           text        not null,                 -- the alternate model re-ranked here
  k                     int         not null,                 -- top-k used for hit/miss
  pool_chunk_ids        uuid[]      not null,                  -- candidate pool (incl. the chunk itself)
  question_count        int         not null,                 -- questions labeled to this chunk
  hit_count             int         not null,                 -- of those, hits under the trial model (in-pool)
  stored_hit_count      int         not null,                 -- baseline hits (stored full-corpus result)
  results               jsonb       not null,                 -- per-question: stored vs trial hit/rank/score
  created_at            timestamptz not null default now()
);
create index eval_model_trials_chunk_idx on eval_model_trials (source_chunk_id, created_at desc);
