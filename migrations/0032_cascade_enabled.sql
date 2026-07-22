-- ============================================================================
-- 0032_cascade_enabled.sql
--
-- Per-config saver-mode toggle for the FrugalGPT generation cascade
-- (lib/rag/efficacyGate.ts + pipeline.answerWithCascade). OFF (default) = one
-- answer from the config's llm_model, no gate, no extra cost; ON = cheap-model-
-- first with axis-2 escalation. Per-config (like llm_model) so configs can A/B
-- saver mode; surfaced in Settings → Savings next to the batch-API preference.
--
-- Read on the hot path via ResolvedConfig (activeConfig().cascadeEnabled), so it
-- costs no extra query per ask().
-- ============================================================================
alter table configs
  add column cascade_enabled boolean not null default false;
