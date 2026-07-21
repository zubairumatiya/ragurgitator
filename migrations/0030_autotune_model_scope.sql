-- ============================================================================
-- 0030_autotune_model_scope.sql
--
-- "Models" scope (Settings → Autotuning): restrict which ALTERNATE embedding
-- models an autotune run may try to a checklist of ids. NULL (the default)
-- means ALL usable models — every model on the cheapest-first ladder
-- (lib/config.autotuneModelLadder) whose provider has a key/weights, minus the
-- config's base model. A non-null array whitelists model ids (embedding-model
-- registry keys, no FK); the engine's usableModelLadder intersects the ladder
-- with it, so an empty array means "size-only" (no alternate models tried).
--
-- The Settings checklist groups the choices by shared vector space, so a user
-- can keep autotune inside the base model's space (voyage-4 family) and avoid
-- opening a separate rank-fusion lane per override — the motivation for the
-- knob (see lib/rag/embeddingModels.vectorSpace).
-- ============================================================================

alter table configs
  add column autotune_model_scope text[];
