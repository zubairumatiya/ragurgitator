-- ============================================================================
-- 0034_savings_totals.sql
--
-- COST ACCOUNTING — the "Costs" section on /appraise (docs/savings-accounting-
-- plan.md, Phase E0). Two counter tables, NOT an event log: the user wants an
-- itemized total per lever rolled into a grand total, not a per-event history.
--
--   savings_totals — one running total per (config, lever). saved_usd is SIGNED:
--     the saver cascade subtracts on an escalation (a wasted cheap attempt), so
--     the total is the true NET. lever ids: 'embed_cache' | 'cascade' |
--     'semantic_cache' | 'batch' | 'bucket_ndcg' (lib/rag/pricing.LEVERS carries
--     each lever's label + category + basis — kept in code, not a column, so the
--     classification is versionable).
--
--   spend_totals  — one running total per (config, surface): what it actually
--     COST, for the "$/month by surface" side. surfaces: 'chat' | 'ndcg_ranking'
--     | 'question_gen' | 'cluster_label' | 'embed'.
--
-- Both are upserted per event by lib/rag/savingsStore. Best-effort exactly like
-- embedding_cache (0020) / semantic_cache (0031): the recorder swallows 42P01 and
-- no-ops when this migration hasn't been applied, so the app runs identically
-- with or without these tables — they only start accruing once created.
--
-- Pure aggregates: safe to truncate (you lose the tally, nothing else). numeric
-- (not float) for saved_usd/spent_usd so fractions-of-a-cent sums don't drift.
-- ============================================================================

create table savings_totals (
  config_id    uuid        not null references configs(id) on delete cascade,
  lever        text        not null,
  event_count  bigint      not null default 0,
  tokens_saved bigint      not null default 0,
  saved_usd    numeric     not null default 0,   -- SIGNED (cascade escalations subtract)
  updated_at   timestamptz not null default now(),
  primary key (config_id, lever)
);

create table spend_totals (
  config_id  uuid        not null references configs(id) on delete cascade,
  surface    text        not null,
  tokens     bigint      not null default 0,
  spent_usd  numeric     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (config_id, surface)
);
