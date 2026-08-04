-- ============================================================================
-- 0041_autotune_run_timings.sql
--
-- Wall-clock history for autotune runs, so a speed optimization can be judged
-- against a measured baseline instead of a memory of how long it "felt".
--
-- The engine has ALWAYS measured this. lib/rag/autotune.runAutotune keeps a
-- total (`durationMs`) plus per-phase accounting (`phase = { search, confirm,
-- rescore }`, fed by the `timed()` wrapper) whose own comment says it exists
-- "so an optimization can be aimed before it's built". Both were emitted in the
-- autotune-done event, rendered once in AutotunePanel, and then dropped on the
-- floor — 0016 gave autotune_runs the tallies (targeted/resolved/attempts) but
-- no clock. Two runs a week apart left nothing to compare. These columns are
-- the missing sink; no new instrumentation was added.
--
--   duration_ms — total wall clock for the run.
--   search_ms   — the fusedTrialRanks dry-runs (Stages 1-3), incl. their embeds.
--   confirm_ms  — applyAutotuneCandidate: persist + real-retrieval re-score, and
--                 the re-score again on a revert.
--   rescore_ms  — the run-end dirty-set ripple (rescoreAffectedQuestions).
--
-- The three phases DO NOT sum to duration_ms, by design (getSummary/splitText
-- and friends are unaccounted). The remainder is real time and the readout
-- shows it as "other" rather than hiding it — a large remainder is itself a
-- finding about where the run's time goes.
--
--   trial_label — groups the N runs of one experiment ('baseline', 'after-X'),
--                 so the Appraise → Trial times tab can median a group and show
--                 the next group's delta against it. Set from the harness
--                 (scripts/autotune-trial.ts) via AUTOTUNE_TRIAL_LABEL; a normal
--                 run from the dashboard leaves it null and is grouped as ad-hoc.
--
-- All nullable and additive, like 0015/0023: rows written before this migration
-- keep working and simply show no timings. Pure telemetry — dropping these
-- columns would lose the history and change nothing about how autotune behaves.
-- ============================================================================

alter table autotune_runs
  add column duration_ms int,
  add column search_ms   int,
  add column confirm_ms  int,
  add column rescore_ms  int,
  add column trial_label text;

-- The tab reads one config's runs newest-first and groups by label; the 0016
-- index already covers (config_id, created_at desc), so this only adds the
-- label lookup for a config with a long ad-hoc history.
create index autotune_runs_trial_idx
  on autotune_runs (config_id, trial_label, created_at desc)
  where trial_label is not null;
