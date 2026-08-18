-- ============================================================================
-- 0071_autotune_apply_default.sql
--
-- Flips the DEFAULT for autotune's "when 1+ candidates pass" mode from 'choose'
-- to 'auto_best', for configs created from here on.
--
-- WHY. 'choose' pauses the sweep on every chunk where more than one candidate
-- family clears the min-rate, and waits for a click on a panel that is reading
-- the event stream. That is a fine way to run a ten-chunk sweep and a bad
-- default for a new account: it is the one setting that makes autotune — the
-- longest bulk action in the app — unable to run as a background job at all
-- (lib/jobs/registry.ts backgroundBlocker), so the default shipped every new
-- user the version that holds a tab open for the whole run. auto_best applies
-- the highest-scoring passing family and keeps going; anyone who wants the
-- per-chunk decision back turns it on in Eval Settings, and the background
-- offer explains the trade the moment it matters.
--
-- EXISTING ROWS ARE LEFT ALONE, deliberately. 0014 made 'choose' the default,
-- so every row written since holds the literal string 'choose' whether the user
-- chose it or never opened the setting — the two are indistinguishable in this
-- column, and an UPDATE here would silently overwrite the deliberate ones. New
-- configs get the new default; existing ones keep whatever they have.
-- ============================================================================

alter table configs
  alter column autotune_apply set default 'auto_best';
