-- ============================================================================
-- 0072_provider_key_usage.sql
--
-- A PER-CALL LEDGER OF EVERYTHING THIS APP DID WITH A USER'S PROVIDER KEY
-- (docs/key-usage-audit-plan.md).
--
-- WHY. BYOK's encryption-at-rest story protects a key from a database breach; it
-- cannot protect it from whoever operates the server, because the plaintext has
-- to exist in memory to be sent to the provider. /account says so out loud. This
-- table is the honest follow-on: detection where prevention is impossible.
--
-- BE EXACT ABOUT WHAT IT CATCHES. The rows are written by the same server that
-- holds the key, so a malicious operator would simply not write them. What this
-- catches is a leaked key spent by a third party, a dependency exfiltrating
-- credentials, a runaway loop in our own code, and "why is my bill $40". Its
-- value is as ONE HALF OF A COMPARISON — our ledger against the provider's own
-- dashboard — which is why /usage is framed as "check this against your
-- provider's records" rather than "check your usage".
--
-- WHY NOT spend_totals (0034). That is a running counter keyed by config_id,
-- answering "what does this config cost to run". This answers "what did MY KEY
-- do", and keys are per-user, not per-config. Different owner, different grain
-- (events, not totals), different retention (pruned, not permanent). Per-config
-- cost stays on /appraise → Costs; the two cross-link and neither absorbs the
-- other.
-- ============================================================================

create table provider_key_usage (
  id            bigserial   primary key,
  user_id       uuid        not null references user_profiles(id) on delete cascade,

  -- ON DELETE SET NULL, and this is the one place in the schema where that is
  -- deliberate rather than sloppy. Every other config-rooted table cascades;
  -- this one must not, because deleting a config is a routine act and it cannot
  -- be allowed to erase an audit trail. The row survives with its context
  -- dropped, which is the correct trade for a record whose whole job is to
  -- still be there when someone goes looking.
  config_id     uuid        references configs(id) on delete set null,

  provider      text        not null,   -- anthropic | voyage | openai | cohere
  model         text        not null,   -- '' for control-plane calls with no model
  surface       text        not null,   -- lib/rag/pricing Surface, plus 'batch'
  kind          text        not null,   -- message|embed|batch_submit|batch_poll|…

  -- RECORDED PER ROW, not derived by joining user_provider_keys. Reconciling
  -- against a provider dashboard is only exact if you can tell which key made
  -- the call, and users rotate mid-period — a derived join to the CURRENT key
  -- would silently reattribute the old key's spend to the new one.
  --
  -- Defaulted rather than NOT NULL-without-default because the lookup can miss
  -- (lib/llm/client.ts caches clients for 60s and the entry can expire between
  -- the call and the flush). An unattributed row is still a real record of a
  -- call and must not be dropped for want of four characters.
  key_last_four text        not null default '',

  input_tokens  bigint      not null default 0,
  output_tokens bigint      not null default 0,
  cost_usd      numeric     not null default 0,

  -- A REJECTED CALL SPENDS NOTHING, which is exactly why the counter tables
  -- never recorded one — and exactly why this one must. A burst of 401s is the
  -- single most interesting row in a key compromise, and it is invisible to
  -- every other ledger in the app.
  ok            boolean     not null,
  error_code    text,

  created_at    timestamptz not null default now()
);

-- The only access pattern: one user's rows, newest first, optionally windowed by
-- time. Both the /usage read and the retention prune sort this way.
create index provider_key_usage_user_time
  on provider_key_usage (user_id, created_at desc);

-- Root-table policy, the 0051:148 form used by user_provider_keys. Required, not
-- optional: the `ensure_rls` event trigger enables RLS on every new table in
-- public, so a policy-less table is deny-all to rag_app — empty reads, rejected
-- writes, no error. Grants are inherited from 0051's default privileges.
create policy rag_app_owner on provider_key_usage
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
