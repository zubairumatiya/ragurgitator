-- ============================================================================
-- 0059_mcp_access.sql
--
-- Adds the per-user kill switch for the MCP server: `mcp_enabled` on
-- user_profiles. See docs/mcp-server-plan.md.
--
-- The MCP endpoint (app/api/mcp) lets a user point their own agent — Claude
-- Code, Claude Desktop, Cursor — at this app over OAuth and read a config
-- summary back. Supabase is the authorization server; we are the resource
-- server. That means the thing standing between a leaked bearer token and a
-- user's data is a token check plus THIS COLUMN, and nothing else.
--
-- DEFAULT FALSE, and that is the whole point. Connecting an agent has to be a
-- deliberate act taken on the account page, for two reasons:
--
--   1. Nobody who has not asked for an MCP server should have one. Every
--      existing account gets `false` from the default, so this migration cannot
--      widen anyone's exposure on its own — the feature ships off.
--   2. It is the ONE switch that works when everything else has failed. Supabase
--      issues only the standard OIDC scopes, so there is no `mcp:read` to
--      withhold and its tokens are not audience-bound to this resource server
--      per RFC 8707 — a token minted for any approved client can call any tool
--      we expose. Per-client revocation exists (auth.oauth.revokeGrant, wired to
--      the Disconnect button on /account), but it needs you to know WHICH client
--      leaked. This column does not.
--
-- Checked at the ROUTE, before any JSON-RPC processing, so flipping it off
-- refuses `initialize` and `tools/list` too — not just `tools/call`. A kill
-- switch that still let a client enumerate the tool surface would be a strange
-- kind of off.
--
-- NO NEW RLS POLICY IS NEEDED, and that is worth stating rather than leaving to
-- inference, because the README's migration checklist says the opposite for the
-- usual case. This adds a column to an existing table, not a new table, so the
-- `ensure_rls` event trigger does not fire and no grant changes. user_profiles
-- already carries a policy from 0051_rls.sql:160-164 — and note it is the one
-- table in the schema keyed on `id` rather than `user_id`:
--
--     create policy rag_app_owner on user_profiles
--       for all to rag_app
--       using (id = app.current_user_id())
--       with check (id = app.current_user_id());
--
-- So a user reads and writes their own flag and nobody else's, for free. If you
-- are adding a TABLE rather than a column, that exemption does not apply to you;
-- go read the README section again.
--
-- Cascade is likewise already handled: user_profiles.id references
-- auth.users(id) on delete cascade, so the flag dies with the account like
-- everything else hanging off it.
-- ============================================================================

alter table user_profiles
  add column mcp_enabled boolean not null default false;

comment on column user_profiles.mcp_enabled is
  'Kill switch for the MCP server (app/api/mcp). Off by default; toggled from /account. '
  'Checked per request before any JSON-RPC processing, so off means the endpoint 403s '
  'every method, not just tools/call.';
