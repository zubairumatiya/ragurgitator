-- ============================================================================
-- 0003_eval_query_cache.sql
--
-- Cache of query-side embeddings for eval questions, so "Re-score all" (and the
-- scoring half of "Process new chunks") stops re-embedding every question on
-- each run. A question's query vector depends ONLY on (question text, embedding
-- model) — not on chunk size/overlap or which chunk is the ground truth — so the
-- cache is keyed by (eval_question_id, model).
--
-- Why a plain real[] and not pgvector's vector(N):
--   The chunks_<model>_<dim> tables use vector(N) because they're SEARCHED over
--   (HNSW nearest-neighbor), and a vector column is fixed-dimension — hence one
--   table per (model, dim). A query embedding is never searched over; it's the
--   search INPUT. We just store it and read it back into query(). So a
--   dimension-agnostic real[] (float4, matching pgvector's internal precision)
--   lets ONE table serve every embedding model — the model is a column and the
--   dimension is simply the array length. Adding a new model needs no new table.
--
-- Cleanup is transitive: documents -> eval_questions (on delete cascade) ->
-- here (on delete cascade), so deleting a document clears its cached vectors too.
-- Invalidation on edit is explicit: updateQuestion() deletes a question's rows
-- when its text changes (the only path that changes it).
-- ============================================================================

create table eval_question_embeddings (
  id               uuid        primary key default gen_random_uuid(),
  eval_question_id uuid        not null references eval_questions(id) on delete cascade,
  model            text        not null,
  embedding        real[]      not null,   -- query vector; length = model's dim
  created_at       timestamptz not null default now(),
  unique (eval_question_id, model)  -- one cached vector per question per model
);
