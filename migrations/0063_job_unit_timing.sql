-- ============================================================================
-- 0063_job_unit_timing.sql
--
-- HOW LONG A UNIT OF WORK TAKES, learned from the runs that already happened.
--
-- The background-jobs feature turns on a question the app never had to answer
-- before: "will this take more than ten minutes?" It has to be answered BEFORE the
-- work starts, since the whole point is to offer the background instead of making
-- someone watch. A hard-coded constant would be wrong on the first machine it met
-- — per-unit cost moves with the embedding model, the corpus, the provider's mood
-- and whether the query vectors are already cached — so this table remembers what
-- actually happened and the estimate is a multiplication.
--
-- ONE EXPONENTIAL MOVING AVERAGE PER (user, kind, variant), not a log of runs. The
-- estimate needs one number, and keeping only the number means there is nothing to
-- age out, no retention question, and no table that grows with usage. `samples`
-- exists so the UI can say "about" honestly: a first estimate from one run is a
-- guess, and after a dozen it is a measurement.
--
-- `variant` is what makes the average comparable — the part of the config that
-- changes the per-unit cost (today: the embedding model). Averaging a run under a
-- local model together with one under a paid API would produce a number that
-- describes neither.
--
-- PER USER, not global. Not for privacy — timings are dull — but because the
-- alternative needs a policy that lets everyone read everyone's rows, and the
-- number is only meaningful against a user's own corpus size and provider keys
-- anyway.
--
-- SAFE TO TRUNCATE: estimates fall back to the seed constants in lib/jobs/timing.ts
-- and re-learn on the next run.
-- ============================================================================

create table job_unit_timing (
  user_id     uuid        not null references user_profiles(id) on delete cascade,
  kind        text        not null,   -- lib/jobs/types.ts JobKind
  variant     text        not null,   -- config facts that change per-unit cost (embedding model)
  ms_per_unit real        not null,
  samples     integer     not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (user_id, kind, variant)
);

-- RLS, in the same migration as the table — see README "Adding a migration".
create policy rag_app_owner on job_unit_timing
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

comment on table job_unit_timing is
  'Exponential moving average of milliseconds per unit of work, per (user, job kind, config '
  'variant). Feeds the "this will take about N minutes — run it in the background?" offer. '
  'Learned from every run, streamed or backgrounded; safe to truncate.';
