-- ============================================================================
-- 0015_chunk_piece_overrides.sql
--
-- Phase B of docs/eval-autotuning-plan.md: generalize the per-chunk override
-- (0013) from "one alternate whole-chunk vector under one model" to a SET OF
-- PIECES, so a chunk can be overridden by a re-split (size), a different model
-- (model), or both (size+model). The model-only override becomes the degenerate
-- case: one piece (piece_index 0) spanning the whole chunk, kind 'model'.
--
-- Retrieval (lib/rag/retriever) ranks override pieces by cosine under their
-- model, collapses to the best piece per source chunk, and RRF-fuses that with
-- the base ANN — so a ground-truth chunk counts as a hit if ANY of its pieces
-- lands in the top-k (eval-autotuning-plan §6). token_start/token_end record each
-- piece's span within the source chunk for the Phase D coverage-gap signal; they
-- stay NULL for whole-chunk and uniform re-splits (which never drop text).
--
-- Additive over the existing table; pre-0015 rows default to piece 0 / 'model'.
-- ============================================================================

alter table config_chunk_overrides
  add column piece_index int  not null default 0,   -- 0..n-1 within the source chunk
  add column text        text,                       -- piece text; NULL => whole base chunk (model-only)
  add column token_start int,                         -- piece span within the source chunk (gap detection)
  add column token_end   int,
  add column kind        text not null default 'model';  -- 'model' | 'size' | 'size+model'

-- The old PK (config_id, source_chunk_id) allowed one row per chunk; a chunk can
-- now own several pieces. Re-key on the piece index.
alter table config_chunk_overrides drop constraint config_chunk_overrides_pkey;
alter table config_chunk_overrides
  add primary key (config_id, source_chunk_id, piece_index);
