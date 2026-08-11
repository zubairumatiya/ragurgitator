-- ============================================================================
-- 0057_baseline_results.sql
--
-- BASELINE MEASUREMENTS, so the headline metrics can carry a ticker showing what
-- per-chunk tuning (autotune's applied overrides, manual delegates) has actually
-- bought on the corpus as it stands today.
--
-- THE DEFINITION. Baseline = what Recall/MRR/nDCG would be if every question
-- currently in the golden set were retrieved under the config's SELECTED
-- embedding model and chunk size/overlap, with NO per-chunk model or shape
-- overrides in effect. Live = the same questions under the config as it actually
-- stands. Ticker = live - baseline. So the number measures tuning, not the
-- choice of model or chunk shape — changing those MOVES the baseline (see
-- baseline_key below), which is the intended behaviour.
--
-- WHY THIS IS NEARLY FREE. Two properties of what's already stored:
--
--   1. retrievalStateFingerprint() (lib/rag/overrideStore.ts) returns the
--      literal string 'baseline' when a config has no overrides, and 0022
--      stamps every result with it. So every result ever scored while the config
--      had no overrides ALREADY IS a baseline measurement — an untuned config
--      gets a complete baseline for nothing, and every question scored before
--      the first override was applied keeps its baseline permanently.
--   2. An override-free retrieval context is `{ ...ctx, overrides: [] }`, which
--      takes retrieveWithCutoffs' fast single-ANN path (lib/rag/retriever.ts).
--      Same query vector, same cached embeddings, no fusion pool. A baseline
--      pass is one extra vector query per question and ZERO provider spend.
--
-- nDCG comes along free too: it is computed at summary time from retrieved_ids
-- against the stored truth order, not by an LLM at scoring time.
--
-- --- is_baseline ------------------------------------------------------------
-- Marks rows produced by the baseline PASS — shadow measurements of a retrieval
-- the user is not running. They must never count toward live metrics or satisfy
-- "has this question been scored?", so every read of eval_results that means
-- "the latest real result" filters them out. That filter is the risky half of
-- this feature: a baseline row mistaken for the latest result would make a
-- baselined question look already-scored and it would never get a real score.
--
-- Baseline rows are stamped retrieval_state = 'baseline', which is the honest
-- fingerprint for the retrieval that produced them and lets the two sources of
-- baseline data (this pass, and the free historical rows from property 1) be
-- read by one query.
--
-- --- baseline_key -----------------------------------------------------------
-- `${embedding model}|${chunk size}|${chunk overlap}` of the config at scoring
-- time. This is what makes "the SELECTED model and chunk shape" enforceable:
-- change any of the three and old baseline rows stop matching, are ignored, and
-- the pass re-runs. Without it the ticker would silently compare against a
-- baseline measured in a different vector space.
--
-- Stamped on live rows too — it costs nothing and makes the same staleness
-- question answerable for both sides.
--
-- BACKFILL. Existing rows get their key from document_embeddings, which records
-- the model/chunk_size/chunk_overlap the label's chunks were actually built
-- under (0001) — so this is the exact shape each old row was scored against,
-- not a guess from the config's current settings. Rows with no eval_label_id
-- keep a NULL key and are simply never counted as baseline.
--
-- RLS. No new policy needed: eval_results reaches its owner through
-- eval_questions -> documents.user_id and its existing policy (0051) covers
-- every column. Adding columns to a policied table inherits that policy.
-- ============================================================================

alter table eval_results
  add column is_baseline  boolean not null default false,
  add column baseline_key text;

update eval_results r
set baseline_key = de.model || '|' || de.chunk_size || '|' || de.chunk_overlap
from eval_labels l
join document_embeddings de on de.id = l.document_embedding_id
where l.id = r.eval_label_id
  and r.baseline_key is null;

-- Serves both the baseline aggregate (scan the baseline rows for a question)
-- and, by the leading column, the `not is_baseline` latest-result lookups.
create index eval_results_baseline_idx
  on eval_results (eval_question_id, is_baseline, scored_at desc);
