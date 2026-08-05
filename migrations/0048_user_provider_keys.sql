-- ============================================================================
-- 0048_user_provider_keys.sql
--
-- Phase 3 of the user-accounts epic (docs/user-accounts-plan.md §4): where a
-- user's own provider API keys live, under envelope encryption.
--
-- THE INVARIANT THIS TABLE EXISTS TO ENFORCE: there is no column that can hold a
-- plaintext API key. Not "we promise not to write one" — there is nowhere to put
-- it. `last_four` is the single plaintext fragment, and four trailing characters
-- of a key that is 40+ characters long is not a credential.
--
-- Two layers, per lib/crypto/envelope.ts:
--   ciphertext   the key under AES-256-GCM, using a per-row DEK
--   wrapped_dek  that DEK, encrypted by a KEK that never leaves Azure Key Vault
--
-- So a database leak yields nothing usable: every column here is inert without
-- a live Key Vault credential, which lives in an entirely separate system. That
-- separation is the whole point — the DB and the vault stay two independent
-- compromises.
--
-- kek_id records the key VERSION that wrapped this row, not the vault or the key
-- name. Rotating the KEK therefore doesn't orphan existing rows: each row knows
-- which key opens it, and a re-wrap pass can move rows forward lazily.
--
-- Deliberately NOT included, though earlier drafts of the plan had them:
-- `label` and `last_used_at`. Nothing reads or writes either one yet, and this
-- repo has already paid once for undocumented columns nobody filled in (see
-- 0042/0047). They can arrive with the code that needs them.
-- ============================================================================

create table user_provider_keys (
  user_id  uuid not null references user_profiles(id) on delete cascade,
  provider text not null,

  -- The sealed credential. All four are meaningless without the vault.
  ciphertext  bytea not null,
  wrapped_dek bytea not null,
  nonce       bytea not null,
  auth_tag    bytea not null,
  kek_id      text  not null,

  -- The only plaintext fragment, ever. Written at save time from
  -- SecretKey.lastFour, which yields '' for anything under 8 characters rather
  -- than leaking a proportionally larger share of a short key.
  last_four text not null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Set when a live call to the provider accepted this key. Save-time
  -- verification means a typo fails at the settings form instead of surfacing
  -- as a broken retrieval three screens later.
  last_verified_at timestamptz,

  -- One key per provider per user: saving again REPLACES. There is no "edit" and
  -- no history, because a superseded key is a live credential we'd be choosing
  -- to keep.
  primary key (user_id, provider),

  -- Matches the providers in lib/auth/providerKeys.ts. 'local' is absent on
  -- purpose: transformers.js runs in-process and has no key to hold.
  constraint user_provider_keys_provider_check
    check (provider in ('anthropic', 'voyage', 'openai', 'cohere'))
);

-- Every lookup is "this user's keys" or "this user's key for provider X"; the
-- primary key already serves both, so no extra index is warranted.
