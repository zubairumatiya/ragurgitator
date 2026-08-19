-- ============================================================================
-- 0073_rls_enable_and_trigger.sql
--
-- Codifies the two things RLS has always depended on and that no migration ever
-- contained. Both were true of the live project by accident of how it was
-- created, and neither survived a rebuild:
--
--   1. `relrowsecurity = true` on every table in `public`. 0051's header is
--      explicit that it inherited this ("All 39 tables in `public` already have
--      relrowsecurity = true … Supabase's default") and therefore only wrote
--      POLICIES. Vanilla Postgres does not enable RLS on `create table`.
--
--   2. The event trigger that keeps (1) true for tables created later. 0051
--      names it and describes what it does, then says it was "created out of
--      band and present in no migration".
--
-- WHAT THAT COST. Replaying migrations/ onto an empty database produced 40
-- policies attached to 41 tables with RLS switched OFF — every policy inert,
-- every tenant able to read every other tenant's rows, and not one error
-- anywhere. The app would have come up and looked correct. Since these files
-- are the only written description of the schema, that was also the answer to
-- "restore from scratch", which makes this a recovery bug and not merely a
-- testing one. Found by the first replay (docs/integration-tests-plan.md).
--
-- Idempotent by construction, and a NO-OP against the live database, where all
-- 44 tables already have RLS on and the function already exists in this form.
-- The point is not to change production; it is that production's shape is now
-- written down.
-- ============================================================================

-- --- 1. the function, exactly as it exists live ------------------------------
-- SECURITY DEFINER because it fires inside whatever role ran the CREATE TABLE,
-- which need not be able to alter the new table. `search_path = pg_catalog` is
-- the standard hardening for a definer function.
--
-- It swallows its own failures deliberately: a migration that creates a table
-- must not be aborted by the trigger that hardens it. A table that slips through
-- is caught instead by the policy-less assertion in rls-check and in the
-- integration tier, which is the right place to fail — loudly, and not mid-DDL.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer set search_path to 'pg_catalog'
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name is not null
       and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog', 'information_schema')
       and cmd.schema_name not like 'pg_toast%'
       and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    else
      raise log 'rls_auto_enable: skip % (system schema or not in enforced list: %.)',
        cmd.object_identity, cmd.schema_name;
    end if;
  end loop;
end;
$$;

-- --- 2. the event trigger ----------------------------------------------------
-- `create event trigger` has no IF NOT EXISTS, so drop first to stay rerunnable.
-- Dropping and recreating in one transaction leaves no window where a concurrent
-- CREATE TABLE could land unprotected.
drop event trigger if exists ensure_rls;
create event trigger ensure_rls
  on ddl_command_end
  execute function public.rls_auto_enable();

-- --- 3. enable RLS on everything that exists now ------------------------------
-- Covers the tables created before this file, which the trigger cannot reach.
-- `schema_migrations` is the migrator's own ledger, not application data, and it
-- is never read through rag_app — excluded so it does not need a policy.
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
      and c.relname <> 'schema_migrations'
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    raise notice 'enabled RLS on %', t.relname;
  end loop;
end $$;
