-- ============================================================================
-- 0050_cache_isolation.sql
--
-- Phase 5 of the user-accounts epic (docs/user-accounts-plan.md §7). 0049 gave
-- the three root tables an owner; every table that carries config_id,
-- document_id or corpus_id inherited one transitively. This closes the last
-- three places where a row is keyed by something GLOBAL, so two accounts land
-- on the same row and one of them silently governs or subsidises the other.
--
-- After this migration no table in `public` is keyed outside a tenant. That was
-- checked by sweeping every `unique` / `primary key` in migrations 0001-0049,
-- not by inspection of the ones that looked suspicious.
--
--   1. semantic_cache_thresholds  (space)                    -> (user_id, space)
--   2. embedding_cache            (model, kind, text_hash)   -> + user_id
--   3. semantic_cache_pairs       unique (hash_a, hash_b)    -> + origin question
--
-- Backfill follows 0049's pattern in all three cases: point existing rows at the
-- first owner by signup order, then lock NOT NULL. The database this was written
-- against holds 1 profile, 0 threshold rows and 2,390 cache rows, so the
-- assignment is unambiguous.
-- ============================================================================

-- --- ownership columns + backfill -------------------------------------------
-- Both columns first, then ONE owner lookup, so the two tables can't disagree
-- about who "the first owner" is. The WHY for each is with its key change below.
alter table semantic_cache_thresholds
  add column user_id uuid references user_profiles(id) on delete cascade;
alter table embedding_cache
  add column user_id uuid references user_profiles(id) on delete cascade;

-- The orphan check is conditional on there being data, for the reason spelled
-- out in 0049's backfill: an empty database has nothing to assign, so demanding
-- an owner there rejects a case this migration handles fine. Real data is still
-- never given a fabricated owner.
do $$
declare
  owner_id uuid;
  orphans  bigint;
begin
  select id into owner_id from user_profiles order by created_at limit 1;

  select (select count(*) from semantic_cache_thresholds where user_id is null)
       + (select count(*) from embedding_cache            where user_id is null)
    into orphans;

  if owner_id is null then
    if orphans > 0 then
      raise exception
        'No user_profiles row to own existing data. Sign up the first account before applying 0050.';
    end if;
    return;
  end if;

  update semantic_cache_thresholds set user_id = owner_id where user_id is null;
  update embedding_cache            set user_id = owner_id where user_id is null;
end $$;

alter table semantic_cache_thresholds alter column user_id set not null;
alter table embedding_cache           alter column user_id set not null;

-- --- 1. per-user calibrated thresholds --------------------------------------
-- WHY THIS IS A CORRECTNESS BUG, not a tidiness one. The threshold is the cosine
-- floor at which the semantic cache SERVES A STORED ANSWER instead of computing
-- a fresh one. Keyed by (space) alone, whoever calibrated last sets that floor
-- for every account on the same embedding space -- and every new account starts
-- on voyage-4-lite, so that is the default collision, not an edge case. Set too
-- low, the cache answers a question with the answer to a different question, and
-- the victim is never told it happened.
--
-- The grain is (user, space), not (config, space), because that is where the
-- evidence pools: the shadow judge draws would-hit traffic from every config the
-- user owns, and a config that wants its own number already has one
-- (configs.batch_savings.semanticCache.threshold overrides outright). The
-- resolution order is unchanged -- config override > this table > the 0.95
-- default in lib/config.ts -- it just no longer reaches across tenants.
--
-- An uncalibrated (user, space) falls back to defaultThreshold (0.95), so a new
-- account's failure direction is "cache too rarely", never "serve a wrong hit".
alter table semantic_cache_thresholds drop constraint semantic_cache_thresholds_pkey;
alter table semantic_cache_thresholds add primary key (user_id, space);

-- --- 2. per-user embedding cache --------------------------------------------
-- 0020 made this table global on purpose, and its header states the reasoning.
-- TWO OF ITS CLAIMS ARE WRONG, and other decisions have been made by reading
-- them, so they are corrected here and in 0020's header rather than left to be
-- rediscovered:
--
--   a) "without retaining anyone's content" is false as a security claim. No raw
--      text is stored, but the EMBEDDING is, and approximate reconstruction of
--      source text from a vector is a published attack. This table holds a lossy
--      copy of every tenant's documents.
--
--   b) The safety argument rests on every lookup arriving with its own
--      text_hash -- a query-shape invariant that nothing enforces and that was
--      ALREADY VIOLATED: lib/rag/replayStore.fingerprint ran an unqualified
--      `select count(*) from embedding_cache where input_kind = 'document'`.
--      That is also a plain functional bug -- any other account's ingest
--      invalidated this user's replay cache. Fixed in the same commit.
--
-- Two further reasons, neither about confidentiality. A shared content-addressed
-- row has NO OWNER, so "delete my data" cannot be honoured for it. And under
-- strict BYOK (Phase 4) it is a cost transfer: Appraise -> Models scores seven
-- models for $0 by replaying banked vectors, so user B's free comparison would
-- run on vectors user A's Voyage key paid for.
--
-- WHAT THIS DOES NOT BUY: protection from anyone who can dump the table -- DB
-- access, a backup, an injection -- who gets every tenant's rows either way. It
-- buys structural isolation that does not depend on an unenforced query shape,
-- deletability, and correct cost attribution. Don't sell it as a defense against
-- embedding inversion.
--
-- The cost is losing cross-user dedup, which for a small user base is close to
-- zero: a new account simply starts cold and pays to embed its own corpus, which
-- is exactly the transfer being closed.
--
-- user_id LEADS the primary key, unlike 0020's model-first ordering. All four
-- columns are equality-matched on every read so lookup cost is unchanged, but
-- the tenancy boundary leading means the delete-cascade on account removal is
-- one index range rather than a scan, and no separate FK index is needed.
alter table embedding_cache drop constraint embedding_cache_pkey;
alter table embedding_cache add primary key (user_id, model, input_kind, text_hash);

-- --- 3. pair uniqueness is per-origin, not global ---------------------------
-- Same class of bug as documents.content_hash, which 0049 fixed for the same
-- reason. `unique (hash_a, hash_b)` is global, and insertPairs writes with
-- `on conflict do nothing`. So if user B generates a pair whose two texts hash
-- to a pair user A already owns, B's row is SILENTLY DROPPED: listPairs (which
-- correctly joins through to documents.user_id) never returns it, so
-- questionsNeedingPairs keeps offering that question forever and B pays the LLM
-- again on every run for a row that can never land. It is also an existence
-- oracle on question text.
--
-- origin_question_id already reaches an owner (eval_questions -> documents
-- -> user_id) and is cascade-deleted with it, so adding it to the key is all
-- the tenancy this table needs -- no user_id column. 0040's canonical (lower
-- hash first) orientation still does its own job inside the new key: stopping
-- ONE question from banking the same text pair twice under both orders.
--
-- NOT NULL is safe: insertPairs has always supplied it, and every existing row
-- has one.
alter table semantic_cache_pairs alter column origin_question_id set not null;
alter table semantic_cache_pairs drop constraint semantic_cache_pairs_hash_a_hash_b_key;
alter table semantic_cache_pairs
  add constraint semantic_cache_pairs_origin_hash_uq unique (origin_question_id, hash_a, hash_b);
