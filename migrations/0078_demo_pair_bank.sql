-- ============================================================================
-- 0078_demo_pair_bank.sql
--
-- Phases 3 and 3b of docs/demo-cache-lab-plan.md: the shelf for the pairs a
-- guest has NOT been handed yet, and for the audited verdicts the clone
-- deliberately blanked on the ones they have.
--
-- WHY A TABLE AND NOT A COLUMN ON semantic_cache_pairs. The two buttons §4 gives
-- a guest — "Generate pairs" and "Screen pairs" — both cost an LLM call the demo
-- carries no key for, so both are served as REVEALS of work the publish already
-- paid for (the same carve-out `cachedOnly` makes for "Add cached" on
-- /api/eval/bulk-generate). A reveal needs somewhere to hold what has not been
-- revealed, and that somewhere cannot be semantic_cache_pairs itself: every
-- reader of that table — pooledPairs, listPairs, the unscreened count — would
-- count an unrevealed row as present. A pair sitting in the pair table with a
-- "not yet revealed" flag is a pair every one of those readers has to be taught
-- about, and the failure mode of forgetting one is a count that moves before the
-- guest presses anything.
--
--   kind='pair'     a WHOLE pair the guest's generate slider will reveal. payload
--                   is the row's insertable columns (everything but `id`), with
--                   origin_question_id ALREADY REMAPPED to the guest's question
--                   at clone time. Remapping on the way in rather than on the way
--                   out is the same rule the rest of the clone follows: the id
--                   map is a temp table that dies with the transaction, so a
--                   payload holding the master's question id would be a foreign
--                   key nobody could resolve afterwards.
--   kind='verdict'  the true values of the five verdict columns (0070) for a pair
--                   that WAS cloned with them blanked, so "Screen pairs" resolves
--                   the unscreened count to F3's audited answer rather than to a
--                   guess. pair_id names the guest's own cloned row.
--
-- pair_id is nullable because it is meaningful for exactly one of the two kinds;
-- ON DELETE CASCADE so a verdict cannot outlive the row it describes (and so the
-- documents-cascade a republish runs takes these with it).
--
-- OWNED BY user_id DIRECTLY, like question_cache (0055), and for the same
-- reason: a kind='pair' row has no pair to hang off yet — that is what makes it
-- banked — so nothing in the ownership graph reaches it transitively. A republish
-- therefore has to delete these explicitly; clone step 0 does, beside
-- question_cache, which is the neighbouring table with the identical property.
--
-- RLS: root-owned, so the 0051 §3a form (`user_id = app.current_user_id()`)
-- rather than the config/question chains §3b and §3c use. The policy MUST ship
-- in this migration: the rls_auto_enable event trigger (0073) switches RLS on
-- for every new table in public, while default grants are inherited and policies
-- are not — so a policy-less table is silently deny-all to rag_app, with empty
-- reads, rejected writes and no error anywhere. rag_app's table-level grants come
-- from 0051's `alter default privileges` and need nothing here; both facts were
-- confirmed against 0051 (§2's grant block, §3a's policy form) rather than
-- assumed, per the new-migration policy checklist.
--
-- Pure demo bookkeeping and safe to truncate: every row is a copy of something
-- the master still holds, and truncating it costs a guest their reveal buttons,
-- nothing else.
-- ============================================================================

create table demo_pair_bank (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references user_profiles(id) on delete cascade,
  kind       text        not null check (kind in ('pair', 'verdict')),
  -- kind='verdict' only: the cloned pair whose verdict columns were blanked.
  pair_id    uuid        references semantic_cache_pairs(id) on delete cascade,
  payload    jsonb       not null,
  created_at timestamptz not null default now()
);

-- Both readers ask the same question — "what does this user have left of this
-- kind?" — the reveal draining it and the panel's count reading its size.
create index demo_pair_bank_user_kind_idx on demo_pair_bank (user_id, kind);

create policy rag_app_owner on demo_pair_bank
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
