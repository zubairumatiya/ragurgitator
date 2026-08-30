-- ============================================================================
-- 0083_demo_replay_tuning.sql
--
-- Phase 6 of docs/demo-real-flow-plan.md: a seventh `demo_replay` kind, and the
-- last of the Eval tab's.
--
--   kind='tuning'  one row (key='overrides'): for every board chunk the master
--                  autotuned, the winning per-chunk override — model, kind, and
--                  each piece with its own vector — plus the saved model trials
--                  that chunk's "Models tried" list reads.
--
-- WHY IT IS BANKED, AND WHICH HALF IS. Autotune is the walk's last step and it is
-- NOT in the demo's blocked table: with the search replaced it spends nothing, so
-- there is nothing to block. What it would spend is the SEARCH — runAutotune
-- embeds every candidate rung of every failing chunk — which on a sixty-question
-- board is plausibly 150k–350k tokens against a 200,000-token guest budget, i.e.
-- the step most likely to end in the budget panel. So a guest's press installs
-- the master's winners and then runs the dirty-set re-score and the run
-- accounting FOR REAL, over their own questions in their own workspace. Every
-- number they read is measured here; what they did not do is the searching, and
-- lib/demo/policy.PUBLISHED_SEARCH_NOTE is the sentence that says so.
--
-- THE VECTORS TRAVEL, which is what makes this a replay rather than a hint: an
-- override is only a measurement because its embedding is the one the master
-- confirmed through real retrieval. They ride as base64 float32 rather than as
-- JSON numbers — exact, and less than half the bytes (see lib/demo/replayCore).
--
-- SCOPED TO THE BOARD, NEVER THE WHOLE CONFIG. The master carries 274 override
-- rows over 99 chunks (~1.15 MB of vectors); the board's ~30 chunks are ~72 rows.
-- The rest name chunks no visitor will ever autotune.
--
-- THE ENTRIES NAME ROWS, so clone step 5j remaps each entry's chunk id and each
-- banked trial's candidate pool through `_map_chunk` on both hops. Both are SETS
-- rather than rankings, so an id that fails to map is DROPPED, exactly as the
-- board's (0081) is and unlike a ranking's (0082), where position is rank.
--
-- A CHECK CONSTRAINT EDIT AND NOTHING ELSE, as 0081 and 0082 were.
-- ============================================================================

alter table demo_replay drop constraint demo_replay_kind_check;

alter table demo_replay add constraint demo_replay_kind_check
  check (kind in ('matrix', 'progress', 'shadow_verdict', 'board', 'ndcg_ideal',
                  'llm_ranking', 'tuning'));
