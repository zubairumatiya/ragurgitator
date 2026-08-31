-- ============================================================================
-- 0077_published_sweep.sql
--
-- Phase 1 of docs/demo-cache-lab-plan.md: somewhere to PUT the cache-key sweep's
-- result, so a guest's Appraise → Semantic caching panel can open with the
-- precision slider already live.
--
-- WHY A TABLE AT ALL. Every other thing the demo publishes is a row the master
-- already keeps — the shadow log, the graded rankings, replay_metrics (0043).
-- The sweep is the exception: runKeyModelSweep computes on demand and returns to
-- the response, and the result dies with the request. There is nothing to clone,
-- so the publish needs a shelf to put the answer on.
--
-- WHAT IT UNLOCKS, which is more than it looks. The panel's precision slider is
-- already free — it re-derives every row from the curves the sweep shipped, with
-- selectFromCurve bundled client-side precisely so dragging costs nothing. It is
-- dark for a guest only because it renders inside `{sweep && …}`, and `sweep` is
-- client state set by a POST a guest may not make. Hand the panel a SweepResult
-- and the whole control is live with zero requests.
--
--   result — the whole SweepResult, thinned (lib/rag/publishedSweep). JSONB
--     rather than a normalised leaderboard table because nothing queries it by
--     field: it is read whole, once, by one panel. A leaderboard schema would
--     also have to model CalibrationResult's curve, which is the part that
--     actually matters here and the part with no fixed width.
--
--   fingerprint — always PUBLISHED_SWEEP_FINGERPRINT today, and a SENTINEL
--     rather than a hash of the inputs for the reason clone step 5c spells out
--     for the replay: a copied real fingerprint is a key nobody in the
--     destination account will ever recompute, i.e. rows present but
--     unreachable. The column exists so a real per-input generation can live
--     beside the published one later, exactly as replay_metrics does.
--
--   config_id — ownership and remapping, NOT scope. The sweep is account-wide
--     (one pooled pair set across every config, since a pair is a property of
--     two question texts), but the clone remaps rows by config and RLS reaches
--     the owner through configs. So the row hangs off the config being
--     published, and a reader must not take that to mean the numbers describe
--     only that config.
--
-- Best-effort like replay_metrics (0043) and embedding_cache (0020): the reader
-- swallows 42P01 and returns null, so the panel behaves exactly as it does today
-- with or without this migration applied.
-- ============================================================================

create table published_sweep (
  config_id   uuid        not null references configs(id) on delete cascade,
  fingerprint text        not null,  -- the sentinel; see above
  result      jsonb       not null,  -- a thinned SweepResult
  computed_at timestamptz not null default now(),
  primary key (config_id, fingerprint)
);

-- Derived-table policy, the 0051:217 form used by replay_metrics. Required, not
-- optional: the rls_auto_enable event trigger (0073) switches RLS on for every
-- new table in public, so a policy-less table is deny-all to rag_app — empty
-- reads, rejected writes, and no error anywhere.
create policy rag_app_owner on published_sweep
  for all to rag_app
  using (exists (select 1 from configs c where c.id = published_sweep.config_id))
  with check (exists (select 1 from configs c where c.id = published_sweep.config_id));
