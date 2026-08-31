-- ============================================================================
-- 0079_probe_attempts.sql
--
-- What a probe TRIED, as opposed to what it managed to record.
--
-- THE LOOP THIS ENDS. eligiblePairs decides a pair is still probeable by asking
-- whether its variant hash appears in semantic_cache_shadow for the current
-- (config_id, fingerprint). That is a sound test for the bulk job, which runs at
-- PROBE_LOOKUP's floor of 0 and therefore records EVERY probe it makes: probe a
-- pair, a row lands, the pair drops out, the run walks forward.
--
-- The single-probe route (phase 4) deliberately raises the floor to
-- config.semanticCache.shadowLogFloor, so that a far-off near-miss does not sit
-- in §3's human queue looking like evidence about the cache. That is the right
-- call for the queue and it silently breaks the walk: a probe below the floor
-- writes no shadow row, so the pair is still eligible, so the very next click
-- selects it again. selectProbes is a total order (hard negatives first, then
-- pairId), so "again" means the SAME pair, forever. Observed in the demo as a
-- button that returns pair 003ea129 on every press while "25 more pairs
-- eligible" never moves.
--
-- WHY NOT JUST RECORD IT ANYWAY, at floor 0, and filter the queue for display.
-- Because the shadow log is read by more than the queue — the calibration curve,
-- the sweep's pooled set, the per-space SHADOW counts, the origin split from
-- 0069 — and widening what lands in it to fix a cursor is a change to the
-- measurement in order to fix the UI. This table changes nothing anyone
-- measures; it only remembers that a question was asked.
--
-- WHY NOT A COLUMN ON semantic_cache_pairs. An attempt is not a property of the
-- pair, it is a property of (this pair, this config, this index). The same pair
-- is legitimately probeable again under a new fingerprint — an ingest moves the
-- corpus and the nearest match genuinely changes — and a column would have to be
-- cleared on every ingest by something that remembered to.
--
-- KEYED EXACTLY LIKE THE CHECK IT BACKS: (config_id, fingerprint,
-- new_query_hash) is recordShadow's on-conflict target, so this table and the
-- shadow log answer the eligibility question in the same terms and cannot drift.
-- Re-probing the same variant is an upsert, not a duplicate.
--
-- FINGERPRINT SCOPING IS THE EXPIRY. Nothing prunes this table: a row stops
-- mattering the moment the config's fingerprint moves, because every read is
-- scoped to the current one. That is the same lifecycle semantic_cache's own
-- rows have, and it is why there is no cleanup job here.
--
-- OWNED THROUGH configs, not by a user_id column — a probe is made in a config's
-- scope and RLS reaches the owner the way published_sweep (0077) does, via the
-- config. The policy MUST ship in this migration: the rls_auto_enable event
-- trigger (0073) switches RLS on for every new table in public while default
-- grants are inherited and policies are not, so a policy-less table is silently
-- deny-all to rag_app — empty reads, rejected writes, and no error anywhere.
--
-- Pure bookkeeping and safe to truncate: the cost of losing it is that a visitor
-- may be offered one pair they have already probed.
-- ============================================================================

create table probe_attempts (
  config_id      uuid        not null references configs(id) on delete cascade,
  fingerprint    text        not null,
  new_query_hash text        not null,
  created_at     timestamptz not null default now(),
  primary key (config_id, fingerprint, new_query_hash)
);

create policy rag_app_owner on probe_attempts
  for all to rag_app
  using (exists (select 1 from configs c where c.id = probe_attempts.config_id))
  with check (exists (select 1 from configs c where c.id = probe_attempts.config_id));
