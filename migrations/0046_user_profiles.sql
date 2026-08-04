-- ============================================================================
-- 0046_user_profiles.sql
--
-- Phase 1 of the user-accounts epic (docs/user-accounts-plan.md): identity only.
-- No ownership columns yet — this migration is safe to apply to a live
-- single-tenant database and changes nothing about how existing data is read.
-- Ownership (corpora/configs/documents.user_id) lands in 0047.
--
-- Supabase Auth owns `auth.users`: signup, password hashing, email confirmation,
-- and session issuance all happen there, and we never write to it. What we own
-- is a PUBLIC-schema mirror carrying app-level fields, for two reasons:
--
--   1. auth.users lives in a schema our app role shouldn't be joining against in
--      ordinary queries, and Supabase reserves the right to change its shape.
--   2. Every future ownership column wants a foreign key into something we
--      control. `references user_profiles(id)` keeps cascades in our schema.
--
-- The row is created by a trigger on auth.users rather than by application code
-- so that "an auth user exists but has no profile" is unrepresentable — signup
-- and profile creation land in the same transaction. lib/auth/dal.ts ALSO
-- self-heals a missing profile, which covers users created before this migration
-- (e.g. through the Supabase dashboard) without needing a backfill pass.
-- ============================================================================

create table user_profiles (
  id         uuid        primary key references auth.users(id) on delete cascade,
  email      text        not null,
  created_at timestamptz not null default now()
);

-- security definer: the trigger fires inside Supabase's auth machinery, whose
-- role has no rights on our public tables. Empty search_path is the standard
-- hardening for a definer function — it forces every reference below to be
-- schema-qualified, so the function can't be hijacked by a shadowing table on a
-- caller-controlled search path.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.user_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill any users that already exist (created via the Supabase dashboard
-- before this trigger existed). No-op on a fresh project.
insert into user_profiles (id, email)
  select id, email from auth.users
  on conflict (id) do nothing;
