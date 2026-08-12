-- ============================================================================
-- 0060_mcp_write_grants.sql
--
-- The app-owned permission slip that lets an MCP client WRITE. Until now every
-- tool on /api/mcp was read-only (describe_config), so the bearer token was the
-- whole story. Adding tools that create rows needs a second, narrower yes.
--
-- WHY A TABLE AND NOT AN OAUTH SCOPE. 0059's header and lib/auth/mcpClaims.ts
-- both record the constraint: Supabase issues only the standard OIDC scopes, so
-- there is no `mcp:write` to mint or to require, and its tokens are not
-- audience-bound to this resource server. A scope check that always passes would
-- look like defence and provide none. So the split is:
--
--   the TOKEN answers "which user, and which client"  (the client_id claim —
--     still the security of the whole feature)
--   THIS TABLE answers "may that pair write, and what"
--
-- The consequence worth stating: a token that leaks buys the reader nothing new.
-- Writing needs a row here, and a row here is only created by a human clicking
-- Approve on /account/mcp-write with a session cookie, which a stolen bearer
-- token cannot produce.
--
-- capabilities text[], NOT a boolean. The approval page can then name exactly
-- what is being granted ("write eval questions" vs. "create configs"), and a
-- write tool added later does not silently inherit a yes the user gave to a
-- different question. Cheap now, painful to retrofit once grants exist. Current
-- values: 'questions_write', 'config_create' (lib/mcp/writeGrantPolicy.ts owns
-- the list; deliberately no CHECK constraint here, so adding one is a code
-- change rather than a migration).
--
-- expires_at NOT NULL, and short. Approval is min(now + 1 hour, the token's own
-- `exp`) — never longer than the credential it accompanies, because a grant that
-- outlived its token would sit here authorizing whatever token the client held
-- next. There is no "until I revoke it" option on purpose: the question this
-- grant answers is "are you at the keyboard right now", and the honest way to
-- ask that is to make it lapse.
--
-- PRIMARY KEY (user_id, client_id): one live grant per client, so re-approving
-- is an upsert that replaces capabilities and extends expiry rather than
-- accumulating rows nobody can reason about. user_id leads so the cascade delete
-- is one index range and no separate FK index is needed — 0050's reasoning for
-- embedding_cache, applied again.
--
-- Cascade: references user_profiles(id), which itself cascades from
-- auth.users(id) (0046), so grants die with the account like everything else.
-- FK to user_profiles rather than auth.users matches every other table here and
-- keeps the reference inside the schema rag_app can actually see.
--
-- EXPIRED ROWS ARE NOT SWEPT. hasCapability filters on `expires_at > now()`, so
-- a stale row authorizes nothing; leaving it means /account can still show "you
-- approved X at 14:02, it lapsed at 15:02", which is the more useful answer than
-- a silently empty table. Revoking deletes outright.
--
-- SAFE TO TRUNCATE: it costs the user one more click on the approval page.
-- ============================================================================

create table mcp_write_grants (
  user_id      uuid        not null references user_profiles(id) on delete cascade,
  client_id    text        not null,   -- the OAuth client_id claim off the token
  capabilities text[]      not null,   -- e.g. {questions_write, config_create}
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,   -- min(now + 1hr, token exp); never open-ended
  primary key (user_id, client_id)
);

-- RLS. This MUST ship in the same migration as the table: the ensure_rls event
-- trigger (0051) enables row security on every new public table automatically,
-- and default grants are inherited while policies are not — so a policy-less
-- table is silently deny-all (empty reads, rejected writes, no error).
create policy rag_app_owner on mcp_write_grants
  for all to rag_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

comment on table mcp_write_grants is
  'Per-(user, OAuth client) permission to call the WRITE tools on /api/mcp. Short-lived: '
  'expires_at is capped at the granting token''s exp. Created only from /account/mcp-write '
  'under a session cookie, so a leaked bearer token cannot mint one.';
