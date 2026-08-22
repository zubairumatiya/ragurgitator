-- ============================================================================
-- 0075_guest_accounts.sql
--
-- Phase 1 of the guest demo (docs/guest-demo-plan.md): a visitor with no account
-- and no API keys clicks "Try the demo" and lands in a real, working workspace.
--
-- THE WHOLE DESIGN IN ONE SENTENCE: a guest is just another user_id that gets
-- deleted a couple of hours later. Every row in this app already belongs to a
-- user and RLS already enforces it, so the demo needs no second data path — it
-- needs an identity, a clone, and a reaper.
--
-- WHAT THIS MIGRATION DOES NOT DO, deliberately:
--
--   • It does not touch RLS. 0051's policies read the `app.user_id` GUC, not
--     auth.uid(), so a guest flows through withUser() exactly like anyone else.
--     Not one policy changes.
--   • It adds no ownership column to any existing data table. The clone writes
--     ordinary rows owned by an ordinary user; nothing downstream can tell.
-- ============================================================================

-- --- 1. the two guest columns ------------------------------------------------
-- On user_profiles rather than a table of their own because every read that
-- needs them (the reaper, the policy gate, the banner) already has the profile
-- row in hand, and a join for two booleans is a join for nothing.
alter table user_profiles
  add column is_guest   boolean     not null default false,
  add column expires_at timestamptz;

-- The reaper's only query: expired guests, oldest first. Partial, because the
-- overwhelming majority of profiles are real accounts with a NULL expires_at
-- and there is no reason to index them.
create index user_profiles_guest_expiry_idx
  on user_profiles (expires_at)
  where is_guest;

-- --- 2. those two columns are OPERATOR-OWNED ---------------------------------
-- user_profiles' policy (0051:161) is `for all` with `with check (id =
-- app.current_user_id())`, so the rag_app role may update its OWN profile row.
-- No route exposes that today — but "guest extends own TTL" should be
-- UNREPRESENTABLE rather than merely unreachable, because the day someone adds
-- a display-name field is the day the update path opens without anyone
-- rereading this file.
--
-- Keyed on current_user rather than on is_guest, so it holds for real accounts
-- too: nobody but the provisioning path (which runs as `postgres`) may mint a
-- guest flag or move an expiry, in either direction.
-- SECURITY INVOKER, unlike the other trigger functions in this schema, and the
-- difference is the whole mechanism rather than a style choice. Inside a
-- SECURITY DEFINER function `current_user` is the function's OWNER — `postgres`
-- — so the check below would compare postgres against 'rag_app' and pass every
-- update, silently. Nothing else in the function needs elevated rights: it reads
-- no table and writes nothing, it only refuses. Verified by
-- test/integration/demoGuest.itest.ts, which caught exactly this.
--
-- `search_path = ''` stays regardless: it costs nothing and keeps the function
-- immune to a shadowing object on a caller-controlled path.
create function public.guard_guest_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'rag_app'
     and (new.is_guest is distinct from old.is_guest
          or new.expires_at is distinct from old.expires_at) then
    raise exception
      'user_profiles.is_guest and expires_at are operator-owned (0075)';
  end if;
  return new;
end;
$$;

create trigger user_profiles_guard_guest_columns
  before update on user_profiles
  for each row execute function public.guard_guest_columns();

-- --- 3. the provisioning ledger, for the per-IP rate limit -------------------
-- One row per guest minted, carrying a SALTED HASH of the visitor's IP and
-- nothing else. Two properties are load-bearing:
--
--   • It is not linked to the guest it created. Deleting the guest must NOT
--     erase the evidence that an address minted one, or the rate limit resets
--     itself every time the reaper runs — which is precisely the window an
--     abuser would aim for. That makes this table intentionally unreachable
--     from auth.users, and scripts/cascade-check.ts names it as such.
--   • The address is hashed, never stored. The rate limit only ever asks "how
--     many from THIS address", which a hash answers exactly; a raw IP would be
--     personal data retained for no additional capability.
--
-- Read and written only through privilegedSql, so rag_app is granted nothing on
-- it and the RLS the event trigger switches on has no policy — deny-all, which
-- is the correct posture for a table no tenant should ever see.
create table demo_provisions (
  ip_hash    text        not null,
  created_at timestamptz not null default now()
);

create index demo_provisions_recent_idx on demo_provisions (ip_hash, created_at desc);
create index demo_provisions_created_idx on demo_provisions (created_at);
