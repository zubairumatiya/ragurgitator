-- ============================================================================
-- 00_auth_shim.sql — TEST FIXTURE, never applied to a real project.
--
-- Supabase provides `auth.users`; a bare Postgres container does not. Four
-- migrations reach into that schema (0046, 0051, 0059, 0060) and between them
-- they touch exactly two columns, so this is the whole surface they need.
--
-- WHY A SHIM RATHER THAN STUBBING user_profiles DIRECTLY. 0046 hangs a
-- `security definer` trigger off `after insert on auth.users` and roots the
-- ownership graph at `references auth.users(id) on delete cascade`. Both are
-- load-bearing and both are what the tests are here to check: inserting a row
-- here must produce a user_profiles row through the REAL trigger, and deleting
-- one must destroy every owned row through the REAL cascade. Faking
-- user_profiles would skip past both and test nothing.
--
-- Applied before 0001 by scripts/migrate.ts when MIGRATE_BOOTSTRAP is set.
-- ============================================================================

create schema if not exists auth;

-- gen_random_uuid() comes from pgcrypto, which 0001 installs. Ordering this
-- file first means it isn't available yet, so no default here: tests pass an
-- explicit id, which they want anyway for assertions.
create table if not exists auth.users (
  id    uuid primary key,
  email text not null
);

-- 0051 grants rag_app DML on `public` only, and deliberately withholds
-- auth.users (account deletion is privilegedSql's job). Mirror that: the shim
-- must not accidentally hand rag_app rights the live project doesn't give it,
-- or an RLS test could pass here and fail in production.
revoke all on schema auth from public;
