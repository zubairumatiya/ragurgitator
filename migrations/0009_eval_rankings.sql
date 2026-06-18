-- ============================================================================
-- 0009_eval_rankings.sql
--
-- Graded ideal rankings for eval nDCG. Each eval question has exactly ONE
-- ground-truth chunk (eval_labels), which makes the old nDCG degenerate (IDCG=1,
-- so it just re-skins MRR). To make nDCG a real graded-relevance metric we give
-- a question an *ordered* list of several relevant chunks — the ideal ranking —
-- and score the active model's retrieval against it (see lib/rag/evalMetrics.ndcg).
--
-- A ranking is built synthetically on /eval (lib/rag/ranking.ts): take the
-- cluster bucket(s) nearest the question, pull a bounded candidate pool, rank it
-- under several embedding models, and aggregate by average rank. Optional LLM
-- rankings and a hand-edited manual ranking are stored alongside as alternatives;
-- the user marks ONE as is_truth, which is what nDCG actually scores against.
--
-- Scoped to the active config via document_embedding_id (model + chunk_size +
-- chunk_overlap), like eval_labels / eval_model_trials: change the config and a
-- question's rankings stop matching, so it shows ungraded again. chunk_ids has no
-- FK (chunks live in per-model chunks_<model>_<dim> tables); cleanup is transitive
-- via the eval_questions and document_embeddings cascades.
-- ============================================================================

create table eval_rankings (
  id                    uuid        primary key default gen_random_uuid(),
  eval_question_id      uuid        not null references eval_questions(id) on delete cascade,
  document_embedding_id uuid        not null references document_embeddings(id) on delete cascade,
  kind                  text        not null check (kind in ('aggregate','llm_pool','llm_rerank','manual')),
  is_truth              boolean     not null default false,  -- the official ground truth nDCG scores against
  chunk_ids             uuid[]      not null,                -- ideal order, best-first
  details               jsonb       not null default '{}',   -- provenance: cluster_run_id, bucket ordinals, per-model ranks, llm model
  created_at            timestamptz not null default now(),
  -- One ranking of each kind per question per config; rebuilding upserts it.
  unique (eval_question_id, document_embedding_id, kind)
);

create index eval_rankings_question_idx on eval_rankings (eval_question_id, document_embedding_id);

-- At most one ground-truth ranking per question per config.
create unique index eval_rankings_truth_idx
  on eval_rankings (eval_question_id, document_embedding_id)
  where is_truth;
