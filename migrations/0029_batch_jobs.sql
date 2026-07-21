-- ============================================================================
-- 0029_batch_jobs.sql
--
-- BATCH API SAVINGS (Phase E1 — docs/batch-api-savings-plan.md). Two additions:
--
--   1. configs.batch_savings — the PER-CONFIG preference edited in the Settings
--      "Savings" subsection: bulk/individual mode, the two bulk leg choices,
--      and the four per-job choices. jsonb (not columns) because the shape is a
--      small nested doc the UI round-trips whole, and it grows as jobs are added.
--      Default = everything "standard" (batch off) so existing configs behave
--      exactly as before until the user opts in.
--
--   2. batch_jobs — the ACCOUNT-WIDE ledger of submitted provider batches. The
--      preference is per-config but a batch runs at the provider account level,
--      so the status panel is global; each row carries config_id AND a
--      denormalized config_label so the panel can tag a request with the tab
--      that launched it even after that config is renamed or deleted (FK is
--      ON DELETE SET NULL, not CASCADE — a deleted config must not erase the
--      audit of a batch that may still be billing / in flight).
--
--   `input` holds whatever applyResults needs to write the batch back (the
--   custom_id -> target map, a cluster run id, difficulty, target chunk table,
--   etc.) — see lib/batch/jobs/*. `status` is our normalized lifecycle; the raw
--   provider status is mapped into it in lib/batch/providers.ts:
--
--     submitting -> in_progress -> completed -> applied
--          |            |             \-(parse/apply error)-> failed
--          \-(submit err)             cancel: -> canceling -> canceled ; expired
-- ============================================================================

alter table configs
  add column batch_savings jsonb not null default '{
    "mode": "bulk",
    "bulk": { "embedding": "standard", "llm": "standard" },
    "jobs": {
      "question_generation": "standard",
      "ndcg_ranking": "standard",
      "cluster_labeling": "standard",
      "ingest_embedding": "standard"
    }
  }'::jsonb;

create table batch_jobs (
  id                      uuid        primary key default gen_random_uuid(),
  provider                text        not null,   -- 'anthropic' | 'voyage'
  provider_batch_id       text,                   -- null until submit returns
  kind                    text        not null,   -- question_generation | ndcg_ranking | cluster_labeling | ingest_embedding
  config_id               uuid        references configs(id) on delete set null,
  config_label            text        not null,   -- config name captured at submit (survives rename/delete)
  status                  text        not null default 'submitting',
  request_count           integer     not null default 0,
  succeeded_count         integer     not null default 0,
  errored_count           integer     not null default 0,
  applied_count           integer     not null default 0,
  input                   jsonb       not null default '{}'::jsonb,
  provider_output_file_id text,                   -- Voyage results file id
  error                   text,
  acknowledged            boolean     not null default false,  -- user dismissed the "done" toast
  email_sent              boolean     not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  completed_at            timestamptz,            -- provider finished processing
  applied_at              timestamptz             -- results written back to the app
);

-- The panel polls "non-terminal" jobs and lists newest-first; the config filter
-- backs the per-config "is a batch of this kind in flight?" overwrite warning.
create index batch_jobs_status_idx  on batch_jobs (status);
create index batch_jobs_config_idx  on batch_jobs (config_id);
create index batch_jobs_created_idx on batch_jobs (created_at desc);
