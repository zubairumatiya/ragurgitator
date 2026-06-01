-- ============================================================================
-- 0002_eval.sql
--
-- Retrieval-quality evals (Recall@k). For each chunk we synthesize a question
-- whose ground-truth answer is that chunk, then measure how often retrieval
-- surfaces that chunk in the top-k results.
--
-- The schema is deliberately shaped for FUTURE config comparison (chunk size /
-- overlap / wording A/B) with no later migration:
--   - eval_questions are DOCUMENT-scoped, so one question can be scored against
--     many embedding runs (configs).
--   - eval_labels hold the ground-truth chunk PER config (embedding run), so the
--     same question maps to a different "correct" chunk under each config.
--   - eval_results keep full history (we never delete old rows), so a question's
--     hit/miss over time shows whether a config change improved it.
--   - eval_runs are aggregate snapshots for run-to-run "did recall improve?".
-- ============================================================================

-- A question about a document's content. DOCUMENT-scoped (not tied to one chunk
-- config) so the SAME question can be scored against multiple embedding runs for
-- fair config A/B. Manually editable; expected_answer is optional and reserved
-- for future config-independent answer matching.
create table eval_questions (
  id              uuid        primary key default gen_random_uuid(),
  document_id     uuid        not null references documents(id) on delete cascade,
  question        text        not null,
  expected_answer text,                                      -- optional, future answer-based scoring
  source          text        not null default 'generated',  -- 'generated' | 'manual'
  generator_model text,                                      -- provenance; null for manual
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index eval_questions_document_idx on eval_questions (document_id);

-- Ground-truth chunk for a question UNDER A SPECIFIC config (embedding run).
-- One question -> one label per config it has been evaluated against. This is the
-- table that makes "same question, many configs" possible without re-authoring.
-- source_chunk_id has no FK because chunks live in per-model tables
-- (chunks_<model>_<dim>); cleanup is transitive via document_embedding_id.
create table eval_labels (
  id                    uuid        primary key default gen_random_uuid(),
  eval_question_id      uuid        not null references eval_questions(id) on delete cascade,
  document_embedding_id uuid        not null references document_embeddings(id) on delete cascade,
  source_chunk_id       uuid        not null,
  created_at            timestamptz not null default now(),
  unique (eval_question_id, document_embedding_id)
);
create index eval_labels_embedding_idx on eval_labels (document_embedding_id);

-- Per-question scoring outcome. Rows are kept (history), so a question's results
-- over time show whether a chunk reword/overlap change improved THAT question.
create table eval_results (
  id               uuid        primary key default gen_random_uuid(),
  eval_question_id uuid        not null references eval_questions(id) on delete cascade,
  eval_label_id    uuid        references eval_labels(id) on delete set null,  -- ground truth used
  k                int         not null,        -- top-k at scoring time
  hit              boolean     not null,        -- was the labeled chunk in top-k?
  found_rank       int,                         -- 1-based rank if found, else null (MRR later)
  retrieved_ids    uuid[]      not null,        -- what came back, for debugging misses
  scored_at        timestamptz not null default now()
);
create index eval_results_question_idx on eval_results (eval_question_id, scored_at desc);

-- Aggregate snapshot for run-to-run comparison: a config snapshot + summary stats,
-- frozen at the end of each "Process new chunks". Diffing two rows = "did recall
-- improve between configs/runs?" without recomputing anything.
create table eval_runs (
  id             uuid        primary key default gen_random_uuid(),
  model          text        not null,
  chunk_size     int         not null,
  chunk_overlap  int         not null,
  k              int         not null,
  question_count int         not null,
  hit_count      int         not null,   -- recall@k = hit_count / question_count
  notes          text,
  created_at     timestamptz not null default now()
);
