-- ============================================================================
-- 0081_demo_replay_board.sql
--
-- Phase 2 of docs/demo-real-flow-plan.md: a fourth `demo_replay` kind, and the
-- one that stops being about the caching lane.
--
--   kind='board'  one row (key='chunks'): the chunk ids the demo's Eval tab is
--                 scoped to, in document order.
--
-- WHY THE DEMO NEEDS ONE AT ALL. Everything that scopes a guest's Eval tab today
-- is DERIVED FROM THE FROZEN SET — `config_question_ignores.reason =
-- 'demo_frozen'` on the ~460 questions a visitor may read but not move. The
-- dashboard's split, the "Demo" banner and the live counts are all
-- `frozenCount > 0` in disguise. The plan empties the board so a visitor can
-- BUILD it (add questions, score them, grade them), and an empty board has no
-- frozen rows — so every one of those goes silent at once and the page renders
-- one card per corpus chunk with nothing on it. The scope has to stop being a
-- property of the questions, because the questions are what the visitor supplies.
--
-- WHY HERE AND NOT A COLUMN ON published_sweep OR A NEW TABLE. 0080's own
-- argument, unchanged: this is account-wide banked state written by a publish and
-- read by a guest's request, which is exactly what a generic (kind, key) store
-- is. The carve-out rule comes with it — every read in lib/demo/replay returns
-- null for anyone who is not a guest, so a real account's chunk query is
-- byte-for-byte what it is today.
--
-- THE IDS ARE THE READER'S OWN. A board is copied through the clone like the
-- matrix, but unlike the matrix it NAMES ROWS: chunk uuids, minted fresh in every
-- workspace. So clone step 5g remaps the payload through `_map_chunk` on both
-- hops, the same rewrite `retrieved_ids` and an ideal's `chunk_ids` already take.
--
-- A CHECK CONSTRAINT EDIT AND NOTHING ELSE. No new table, no new policy: the
-- 0080 rows this joins already carry rag_app's owner policy, and a kind is a
-- string in a column.
-- ============================================================================

alter table demo_replay drop constraint demo_replay_kind_check;

alter table demo_replay add constraint demo_replay_kind_check
  check (kind in ('matrix', 'progress', 'shadow_verdict', 'board'));
