-- ============================================================================
-- 0069_shadow_origin.sql
--
-- Records WHERE A SHADOW ROW CAME FROM: real traffic, or a synthetic probe
-- written to exercise the calibration curve (docs/resume-metrics-plan.md §F2).
--
-- WHY. semantic_cache_shadow is the sole input to the precision-at-threshold
-- sweep (calibrateFromJudged), and the sweep's output is a SERVING threshold for
-- real questions. F1 (2026-08-17) put 210 engineered near-misses into the table
-- — half of them hard negatives — and by doing so moved the app's own
-- recommendation for the voyage-4 space. That was the right experiment and the
-- wrong side effect: the curve it produces is a WORST-CASE BOUND against an
-- adversarial question mix, not an estimate of what this account's traffic does,
-- and nothing in the schema could tell the two apart. F2 is about to add more
-- synthetic rows, deliberately BELOW config.semanticCache.shadowLogFloor, so the
-- distinction has to become a column before the table grows again.
--
-- With `origin` in place calibrationCurve defaults to origin = 'traffic' — the
-- live recommendation is derived only from questions someone actually asked —
-- and the probe rows stay queryable for the bound.
--
-- 'traffic' is the correct default for every pre-existing row and for every
-- future lookup: recordShadow stamps 'probe' only when a caller explicitly asks
-- for it (semanticCacheLookup's `shadow` option), which no serving path does.
--
-- THE BACKFILL IS A TIME WINDOW, not a list of probe hashes, because the window
-- is both exact and more correct. `npm run f1 -- probe` ran as one uninterrupted
-- pass from 06:43:40Z to 07:07:45Z on 2026-08-17; the table's previous row is
-- from 02:51Z, so there is a ~3h52m gap on each side and no traffic can be
-- caught in it. It inserted 210 rows. docs/resume-metrics-f1-probes.json records
-- 211 probes as logged, and the difference is the point: one probe's text was
-- byte-identical to a question Phase 8's real traffic had already logged, so
-- `on conflict (config_id, fingerprint, new_query_hash) do nothing` kept the
-- ORIGINAL row and the probe's readback found it. That row is genuine traffic
-- that a probe happened to duplicate, and it must stay 'traffic' — a hash-list
-- backfill would have relabelled it. (It carries a human verdict now, written by
-- `apply-truth`; that verdict is about the same question text either way, so it
-- stands.)
--
-- Pure telemetry, like the rest of this table: safe to truncate, and
-- recordShadow tolerates the column not existing (42703) by falling back to a
-- column-less insert, so shadow logging survives an unapplied 0069.
-- ============================================================================

alter table semantic_cache_shadow
  add column origin text not null default 'traffic';

alter table semantic_cache_shadow
  add constraint semantic_cache_shadow_origin_ck
  check (origin in ('traffic', 'probe'));

-- F1's probe pass. Bounded on both sides rather than open-ended: an open
-- `>= 06:43` would also swallow every row F2 and later runs write, and those get
-- stamped at insert time by recordShadow instead.
update semantic_cache_shadow
   set origin = 'probe'
 where created_at >= timestamptz '2026-08-17 06:43:00+00'
   and created_at <  timestamptz '2026-08-17 07:08:00+00';

-- NO NEW INDEX. 0035's (config_id, space, sim desc) already narrows the sweep to
-- one space's rows, which is a few hundred; calibrationCurve splits those by
-- origin in JS so that one read can report both the kept and the excluded count.
-- Revisit if the shadow log ever grows by an order of magnitude.
