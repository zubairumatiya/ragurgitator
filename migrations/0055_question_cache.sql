-- ============================================================================
-- 0055_question_cache.sql
--
-- A per-user, content-addressed store of GENERATED EVAL QUESTIONS, so authoring
-- questions for a passage is paid for once per account instead of once per
-- config.
--
-- THE WASTE THIS CLOSES. Question generation is already idempotent within a
-- config: chunksNeedingQuestionsByDifficulty (lib/rag/evalStore.ts) keeps only
-- chunks where `have < target` and generates the difference, so pressing "Add"
-- twice with the same staged counts costs nothing. But that gap query is scoped
--
--     where de.config_id = ${activeConfig().id}
--
-- so a SECOND config over the same corpus has new chunk rows and a new
-- document_embeddings id, every (chunk, difficulty) slot reads as missing, and
-- the whole question set is bought again — even where the chunk text is
-- byte-identical to text already paid for. For the AB-testing workflow (configs
-- differing on retrieval/rerank/generation but sharing an ingest setup) that is
-- a full re-purchase per config.
--
-- WHY A HIT IS EXACT, NOT APPROXIMATE. Only four inputs reach the model
-- (questionRequestParams, lib/rag/eval.ts): the chunk text verbatim, `count`,
-- `difficulty`, and the config's llm_model. There is no temperature, no top_p,
-- no seed and no user-editable prompt. So a row keyed on the hash of the exact
-- chunk text, at the same difficulty and model, IS a valid question for that
-- passage — this table never serves a question authored from different text.
-- That is what separates it from remapping a question onto a differently-chunked
-- passage, which lib/rag/reconfigure.ts does as best-effort salvage and which
-- this cache deliberately does not do.
--
-- WHY IT IS ITS OWN TABLE AND NOT A LOOKUP OVER eval_questions. eval_questions
-- is already document-scoped and config-free, which makes reusing it directly
-- look free. It fails on lifetime: eval_labels cascade from document_embeddings
-- -> configs, so deleting the originating config leaves the question with no
-- anchor to any chunk text (unreusable), and deleting the DOCUMENT cascades
-- eval_questions away outright (0002_eval.sql). It also fails on indexing —
-- chunk text lives in per-model chunks_<model>_<dim> tables with no hash column,
-- so matching identical text across configs means joining a dynamic set of
-- tables on full text. This table has NO foreign key to documents or configs by
-- design, exactly like embedding_cache (docs/ingest-embed-cache-plan.md): banked
-- questions outlive both, so delete-and-re-upload and delete-a-config are free.
--
-- THE KEY, field by field:
--   user_id        partitions the store. Leads the primary key so the cascade
--                  delete is one index range and no separate FK index is needed
--                  — the same reasoning 0050 applied to embedding_cache. Two
--                  accounts holding the same corpus bank a row each: under
--                  strict BYOK one account's key must not pay to bank a question
--                  another reads free, and it closes an existence oracle over
--                  another tenant's content.
--   llm_model      the authoring model; a question written by a cheap model must
--                  not silently stand in for one the user asked a better model for.
--   difficulty     'easy' | 'medium' | 'hard'. Plain text with no CHECK, matching
--                  eval_questions.difficulty (0005). Never null here — only the
--                  bulk/on-demand generators write this table, and they always
--                  target a difficulty.
--   text_hash      sha256 hex of the exact chunk text (UTF-8), the same
--                  convention as embedding_cache.text_hash.
--   prompt_version derived in code from the prompt constants themselves
--                  (GENERATION_SYSTEM + the three difficulty steers + the JSON
--                  schema), not hand-maintained. Editing any of them changes the
--                  fingerprint and invalidates the cache automatically, instead
--                  of silently serving questions written to older instructions.
--   slot           0-based. A target of 3 needs three DISTINCT questions for one
--                  chunk, so without a slot the cache would serve the same
--                  question three times. A config wanting 2 takes slots 0-1.
--
-- `count` is deliberately NOT in the key. The inline path asks for N questions in
-- one call and the batch path asks for one per request, so the rendered user turn
-- differs ("Write exactly N question(s)"). That is a rendering detail — the
-- question produced for slot i of a given chunk at a given difficulty is
-- equivalent either way — and excluding it is what lets the two paths share one
-- cache instead of maintaining two disjoint ones.
--
-- input_tokens / output_tokens carry the generating call's real usage, divided by
-- the number of questions that call returned. They exist so the savings lever can
-- price a reuse from what the work actually cost rather than from a char/4
-- estimate of the question text. Nullable-free with a 0 default: a row banked
-- without usage (a provider that returned none) simply banks no dollars.
--
-- SAFE TO TRUNCATE. Every row is reconstructible by paying for it again; nothing
-- references this table. Truncating costs money on the next generation run and
-- nothing else.
-- ============================================================================

create table question_cache (
  user_id         uuid        not null references user_profiles(id) on delete cascade,
  llm_model       text        not null,
  difficulty      text        not null,       -- 'easy' | 'medium' | 'hard'
  text_hash       text        not null,       -- sha256 hex of the exact chunk text
  prompt_version  text        not null,       -- fingerprint of the prompt constants
  slot            int         not null,       -- 0-based; distinct questions per chunk
  question        text        not null,
  expected_answer text,
  input_tokens    int         not null default 0,   -- generating call's usage, per question
  output_tokens   int         not null default 0,
  created_at      timestamptz not null default now(),
  primary key (user_id, llm_model, difficulty, text_hash, prompt_version, slot)
);

-- RLS. This MUST ship in the same migration as the table: the ensure_rls event
-- trigger (0051) enables row security on every new public table automatically,
-- and default grants are inherited while policies are not — so a policy-less
-- table is silently deny-all (empty reads, rejected writes, no error).
create policy rag_app_owner on question_cache
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
