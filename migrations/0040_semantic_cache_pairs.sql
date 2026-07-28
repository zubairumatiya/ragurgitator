-- ============================================================================
-- 0040_semantic_cache_pairs.sql
--
-- The GENERATED half of the cache-key model eval pair set
-- (docs/semantic-cache-key-model-plan.md, Phase 2). Each row is two question
-- texts plus a label: would ONE answer serve BOTH?
--
-- Numbered 0040, not the 0039 the plan doc named — 0039 was taken by
-- drop_bucket_ndcg_savings before this landed.
--
-- Why a generated set exists at all, given semantic_cache_shadow already holds
-- judged pairs: shadow rows are CENSORED. A row only exists if it cleared
-- config.semanticCache.shadowLogFloor (0.8) UNDER THE MODEL IN USE AT CAPTURE
-- TIME. A pair the current model scores 0.5 (never logged) but a candidate model
-- scores 0.97 is invisible, so scoring a candidate on shadow rows alone
-- systematically UNDER-estimates its false-positive rate. The two sources are
-- unioned in JS at sweep time (lib/rag/keyModelSweep.ts); neither is sufficient
-- alone.
--
-- Design decisions:
--   - Only the GENERATED set is stored. The shadow half is read live from
--     semantic_cache_shadow, so there is no duplicated copy to keep in sync.
--   - label is ANSWER-LEVEL, not question-level: 'same' means the origin
--     question's answer would fully serve the other text; 'different' means it
--     would not. This MUST match what a shadow verdict means (JUDGE_SYSTEM in
--     semanticCacheCalibration.ts asks exactly that question) or pooling the two
--     sources would mix two different targets. The generation prompt is written
--     against the answer-level target for this reason.
--   - difficulty records HOW the row was produced. 'hard-negative' is the point
--     of the whole exercise: random distinct pairs are separated near-perfectly
--     by every model and discriminate nothing, so a set without hard negatives
--     grades every candidate the same.
--   - origin_question_id ties a row back to the eval question it was generated
--     from, whose ground truth makes the answer-level label checkable. ON DELETE
--     CASCADE: a deleted eval question takes its generated pairs with it, since
--     the label's provenance is gone.
--   - unique (hash_a, hash_b) on sha256 of the texts — a text pair is stored
--     once no matter how many origin questions would produce it. Callers insert
--     with a canonical (lower hash first) ordering so a pair can't be stored
--     twice under both orientations; the label is symmetric, so orientation
--     carries no information.
--   - Pure cache semantics: safe to truncate (regenerate at a cost), and the app
--     tolerates this table not existing (42P01) and degrades to a shadow-only
--     sweep — matching 0031 / 0034 / 0037.
-- ============================================================================

create table semantic_cache_pairs (
  id                 uuid        primary key default gen_random_uuid(),
  origin_question_id uuid        references eval_questions(id) on delete cascade,
  text_a             text        not null,   -- the origin question
  text_b             text        not null,   -- the paraphrase / hard negative
  hash_a             text        not null,   -- sha256(text_a)
  hash_b             text        not null,   -- sha256(text_b)
  label              text        not null check (label in ('same', 'different')),
  difficulty         text        not null check (difficulty in ('paraphrase', 'hard-negative')),
  generated_by       text        not null,   -- the LLM that produced text_b
  created_at         timestamptz not null default now(),
  unique (hash_a, hash_b)
);

-- The sweep reads the whole set at once; the origin index backs the
-- "which questions already have pairs?" gap query that generation runs first so
-- a re-run tops up instead of re-paying for what exists.
create index semantic_cache_pairs_origin_idx
  on semantic_cache_pairs (origin_question_id);
