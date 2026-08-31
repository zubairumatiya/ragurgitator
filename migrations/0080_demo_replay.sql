-- ============================================================================
-- 0080_demo_replay.sql
--
-- Phase 1 of docs/demo-cache-replay-plan.md: the shelf for the SIMILARITY MATRIX
-- a publish banks, so that every paid step of Appraise → Semantic caching is, in
-- the demo, a replay of arithmetic the master actually performed.
--
-- WHY A MATRIX AND NOT A RESULT. Everything the key-model leaderboard prints —
-- τ, recall, precision, AUC, the thinned curve behind the precision slider — is
-- a pure function of one `{sim, label}[]` per candidate model (scoreModel,
-- lib/rag/keyModelSweep.ts:205). The EMBEDDINGS are what a guest cannot afford;
-- the cosines are cheap, small and durable. Banking them rather than the sweep's
-- output is what makes the demo's pair count `n` CONTINUOUS: the route runs the
-- real `calibrateFromJudged` over the first `n` rows, so 37 pairs prints what a
-- real sweep over 37 pairs would have printed, rather than the nearest banked
-- checkpoint. It is also SMALLER than what it replaces (~30 kB of floats against
-- ~112 kB of pair rows), so demo egress goes down.
--
-- WHY A TABLE AND NOT A COLUMN ON published_sweep (0077). That row is one
-- config's finished answer; this is an account-wide INPUT that three different
-- readers subset differently (the pair counts, the leaderboard, the pair-bank
-- collision floor), plus two other kinds of banked state that have nothing to do
-- with a sweep. A generic (kind, key) store is the shape those three kinds
-- actually share.
--
--   kind='matrix'          one row (key='pooled'): the cosine per pair per
--                          candidate model, each pair's label / source / origin /
--                          difficulty / quarantine state, and a stable hash
--                          identity, in the master's own stable order. "The first
--                          `n`" has to mean the same `n` pairs on both sides of
--                          the clone and across BOTH publish hops, which is why
--                          the order is captured rather than re-derived and why
--                          each pair carries a hash rather than a position.
--   kind='progress'        one row (key='pairs'): how far this guest's generate
--                          slider has advanced, and whether they have screened.
--                          The ONLY mutable kind — a guest's clicks write here
--                          and nowhere else.
--   kind='shadow_verdict'  one row per queued shadow event (key = the guest's own
--                          semantic_cache_shadow id): the verdict the operator's
--                          judge really returned, which clone step 5b currently
--                          blanks and throws away. "Run judge over queue" applies
--                          these instead of calling a judge.
--
-- OWNED BY user_id DIRECTLY, like demo_pair_bank (0078) and question_cache
-- (0055), and for the same reason: a banked measurement describes work that no
-- row in the guest's workspace performed, so nothing in the ownership graph
-- reaches it transitively. A republish therefore has to delete these explicitly;
-- clone step 0 does, beside question_cache.
--
-- kind='shadow_verdict' keys a shadow row by TEXT id rather than by a foreign
-- key, deliberately: the clone writes these in the same transaction that mints
-- the shadow rows, and a real FK would add a second ordering constraint to a
-- step whose ordering is already load-bearing. The rows are pure demo
-- bookkeeping — every one is a copy of something the master still holds — so a
-- stale key costs a replayed verdict, nothing else, and the user_id cascade
-- still guarantees account deletion collects them.
--
-- PRIMARY KEY (user_id, kind, key) rather than a surrogate id: every read asks
-- "what does this user have of this kind (under this key)?", and every write is
-- an upsert that must REPLACE rather than append — a republish that stacked a
-- second build's matrix on the last one's is exactly the failure this shape
-- makes unrepresentable.
--
-- RLS: root-owned, so the 0051 §3a form (`user_id = app.current_user_id()`). The
-- policy MUST ship in this migration: the rls_auto_enable event trigger (0073)
-- switches RLS on for every new table in public, while default grants are
-- inherited and policies are not — so a policy-less table is silently deny-all
-- to rag_app, with empty reads, rejected writes and no error anywhere. rag_app's
-- table-level grants come from 0051's `alter default privileges` and need
-- nothing here.
--
-- WHAT THIS MIGRATION DOES **NOT** DO. The plan retires demo_pair_bank (0078)
-- and the guest's use of published_sweep (0077), both of which this store
-- replaces. Neither is dropped here, because their readers are still live on
-- this branch (lib/demo/pairBank.ts, clone steps 5e/5f, two itests): a drop that
-- lands before its readers do leaves the branch broken at every commit in
-- between. The drop is a migration of its own, in the phase that deletes them.
-- ============================================================================

create table demo_replay (
  user_id    uuid        not null references user_profiles(id) on delete cascade,
  kind       text        not null check (kind in ('matrix', 'progress', 'shadow_verdict')),
  key        text        not null,
  payload    jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, key)
);

create policy rag_app_owner on demo_replay
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
