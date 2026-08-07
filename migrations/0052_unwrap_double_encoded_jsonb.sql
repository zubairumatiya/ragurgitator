-- ============================================================================
-- 0052_unwrap_double_encoded_jsonb.sql
--
-- Repairs rows written by `${JSON.stringify(value)}::jsonb`, which does not do
-- what it reads like. The `::jsonb` cast makes Postgres resolve the parameter's
-- type to jsonb, postgres.js then applies its OWN jsonb serializer to the string
-- that was already stringified, and the column stores a jsonb STRING SCALAR
-- whose contents are the JSON text — `"{\"answer\": …}"` rather than
-- `{"answer": …}`.
--
-- The write succeeds, so nothing complains at the time. The damage shows up on
-- the READ: the value comes back as a JS string where the type annotation
-- promises an object, so every field access is `undefined`. Downstream that
-- surfaced as an UNDEFINED_VALUE on a shadow-log insert (semantic_cache.result
-- → `result.answer`), several files away from the code that wrote the bad row.
--
-- The code fix is lib/db.ts's toJsonb(); this unwraps what is already stored.
-- `#>> '{}'` extracts a jsonb scalar as text, so re-casting parses it exactly
-- once. Guarded by jsonb_typeof = 'string' so it is idempotent and cannot touch
-- a correctly-stored object.
--
-- semantic_cache is a CACHE and a corrupt row serves an `undefined` answer, so
-- those rows are deleted rather than repaired — they cost one regeneration.
-- eval_results.screen_cutoffs is measurement data that cannot be recomputed
-- cheaply, so it is unwrapped in place.
-- ============================================================================

delete from semantic_cache
where jsonb_typeof(result) = 'string';

update eval_results
set screen_cutoffs = (screen_cutoffs #>> '{}')::jsonb
where screen_cutoffs is not null
  and jsonb_typeof(screen_cutoffs) = 'string';
