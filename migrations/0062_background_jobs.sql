-- ============================================================================
-- 0062_background_jobs.sql
--
-- BACKGROUND JOBS — the ledger for bulk work that outlives one HTTP request.
--
-- WHY THIS EXISTS AT ALL. The long bulk actions (re-score, bulk nDCG, autotune)
-- run today as NDJSON streams whose producer is deliberately detached from the
-- request (lib/http/ndjson.ts), so closing the tab does not stop them. That works
-- on a long-lived `next start`. It cannot work on Vercel, where a function is
-- killed at its maxDuration — 300s on Hobby — and `after()`/waitUntil work counts
-- against the SAME clock. A 40-minute autotune is therefore not expressible as one
-- invocation anywhere we might deploy.
--
-- So a background job here is not one process. It is a SEQUENCE OF SLICES: each
-- slice works until a soft deadline, checkpoints `cursor` into this row, and
-- chains the next slice over HTTP. This table is the only thing that survives
-- between them, which is why it holds the cursor, the progress and the lease
-- rather than any in-memory registry.
--
-- THE LEASE IS THE SAFETY-CRITICAL PART. Two things can try to advance a job at
-- once: the chain the previous slice fired, and the janitor sweep that revives
-- stalled jobs. These slices spend money (LLM and embedding calls), so a double
-- run is not merely wasteful bookkeeping. `lease_token` + `lease_expires_at` make
-- claiming a job a single conditional UPDATE … RETURNING; whoever's UPDATE returns
-- a row owns the slice, and the other caller finds nothing and leaves.
--
-- The lease EXPIRES rather than being released reliably, because the failure mode
-- it exists for is a process that went away without releasing anything. Expiry is
-- what makes a crashed slice recoverable at all; the cost is that a slice which
-- runs past its lease can be double-claimed, so the budget (lib/jobs/runner.ts)
-- must stay comfortably under the lease window.
--
-- CANCELLING IS A STATUS, AND THAT IS THE POINT. lib/http/cancelRegistry.ts is
-- process-local and says so in its header: on a multi-instance deployment a cancel
-- that lands on another instance finds nothing. `status = 'cancelling'` is the
-- durable version — the running slice reads it at its next checkpoint and breaks
-- out of the loop. Same cooperative semantics: cancellation is a FLAG, never an
-- exception, so partial work commits instead of rolling back.
--
-- `cursor` is OPAQUE HERE. Its shape belongs to the step implementation for each
-- kind (lib/jobs/steps/*), because only that code can say what "where I got to"
-- means — a question id for re-score, a phase plus an index for autotune. Storing
-- it as jsonb keeps this table out of that argument.
--
-- `scope` is the launch request (document ids, rebuild flags), frozen at create
-- time. Separate from `cursor` on purpose: scope is what the user asked for and
-- never changes, cursor is where we are and changes every slice. Re-deriving scope
-- from the cursor, or vice versa, is how a resumed job silently widens.
--
-- user_id is NOT NULL, unlike batch_jobs (0049). There, a nullable owner records
-- an orphaned historical row that the poller simply never advances again. Here the
-- owner is load-bearing machinery: the tick endpoint carries no session, so the
-- runner resolves the owner FROM THIS COLUMN to enter withUser() at all. A job
-- with no owner could not be run, only stared at.
--
-- config_id is ON DELETE CASCADE, also unlike batch_jobs. A provider batch keeps
-- its audit row after its config is gone because it may still be billing at the
-- provider. A background job is entirely ours and entirely config-scoped work; if
-- the config is gone there is nothing to resume, nothing to score, and nothing the
-- panel could usefully say. config_label is still denormalized so a job that
-- outlives a RENAME is attributed to the tab that launched it.
--
-- SAFE TO TRUNCATE between runs: it costs unfinished jobs, not any source data.
-- ============================================================================

create table background_jobs (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references user_profiles(id) on delete cascade,
  config_id     uuid        not null references configs(id) on delete cascade,
  config_label  text        not null,   -- captured at launch; survives a rename

  kind          text        not null,   -- lib/jobs/types.ts owns the list (no CHECK, same reason as status below)
  -- queued -> running -> succeeded
  --              |  \-> failed
  --              \-(cancel)-> cancelling -> cancelled
  -- No CHECK constraint, matching 0060's reasoning: the parse lives in
  -- lib/jobs/types.ts, so adding a status is a code change, not a migration.
  status        text        not null default 'queued',

  scope         jsonb       not null default '{}'::jsonb,  -- the launch request, frozen
  cursor        jsonb,                                     -- null until the first checkpoint
  result        jsonb       not null default '{}'::jsonb,  -- headline numbers for the email + panel

  total_units   integer     not null default 0,  -- estimated at plan() time; may be revised
  done_units    integer     not null default 0,
  last_message  text,                            -- newest progress line, for the panel

  -- The lease. Both null = nobody is running this slice.
  lease_token       uuid,
  lease_expires_at  timestamptz,
  -- Slices, not retries: every claim increments this, so a job that keeps being
  -- re-leased without done_units moving is visibly stuck rather than quietly busy.
  attempts      integer     not null default 0,

  error         text,
  acknowledged  boolean     not null default false,  -- user dismissed the "done" toast
  email_sent    boolean     not null default false,  -- completion mail fired once

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  started_at    timestamptz,   -- first slice claimed
  finished_at   timestamptz    -- reached a terminal status
);

-- RLS. MUST ship with the table: the ensure_rls event trigger (0051) enables row
-- security on every new public table, default grants are inherited but policies
-- are not, so a policy-less table is silently deny-all. Owner-rooted shape, same
-- as batch_jobs and mcp_write_grants.
create policy rag_app_owner on background_jobs
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

-- The panel lists a user's jobs newest-first.
create index background_jobs_user_idx on background_jobs (user_id, created_at desc);
-- The janitor sweep asks one question — "which of my jobs is running but has no
-- live lease?" — so the partial index carries exactly the non-terminal rows.
create index background_jobs_live_idx on background_jobs (user_id, lease_expires_at)
  where status in ('queued', 'running', 'cancelling');
-- Backs the per-config "a background job is already running on this config"
-- guard, the analogue of batch_jobs' in-flight warning.
create index background_jobs_config_idx on background_jobs (config_id)
  where status in ('queued', 'running', 'cancelling');

comment on table background_jobs is
  'Long bulk actions run as a sequence of slices that checkpoint here, so they survive a '
  'serverless function timeout and a closed browser tab. lease_token/lease_expires_at make '
  'claiming a slice atomic; status=''cancelling'' is the durable, cross-instance cancel that '
  'lib/http/cancelRegistry.ts cannot provide.';
