-- ============================================================================
-- 0082_demo_replay_rankings.sql
--
-- Phase 5 of docs/demo-real-flow-plan.md: two more `demo_replay` kinds, both of
-- them the Eval tab's, both of them a ranking the master already made.
--
--   kind='ndcg_ideal'   one row (key='aggregate'): the ideal chunk order the
--                       master's cross-model aggregate builder produced for each
--                       question the published bank can hand out.
--   kind='llm_ranking'  one row (key='rerank'): the llm_rerank order for the same
--                       questions, bought once on the master at publish time.
--
-- WHY THEY ARE BANKED. "Bulk actions → Add nDCG rankings" embeds a 30-chunk
-- candidate pool under EVERY model on the aggregate list, per question; "Add LLM
-- nDCG rankings" spends one answer-model call per question. Both are steps 4 and
-- 5 of the demo's walk, and neither is affordable per visitor. What a guest
-- cannot buy is the RANKING; the grading that follows — ndcg(ideal,
-- retrieved_ids, k) over their own retrieval — is arithmetic, and it stays live.
-- That split is the whole point: the ideal is the master's, the ordering being
-- graded is the visitor's.
--
-- ONE ROW PER KIND, NOT ONE PER QUESTION. The key would otherwise have to name a
-- question, and a question is exactly what does not survive the clone — the
-- published build ships NO eval_questions at all (§3.2), and a guest's rows are
-- minted from the bank on their first press. So each payload is an array of
-- entries keyed by a hash of the question TEXT, which is what the bank carries
-- and what the guest's row will hold verbatim.
--
-- THE ENTRIES NAME ROWS, so clone step 5i remaps every entry's chunk ids through
-- `_map_chunk` on both hops — the same rewrite the board (0081) takes, except
-- that here position is RANK: an id that fails to map holds its place as a null,
-- exactly as step 4c's ideal does, because dropping it would silently promote
-- every chunk behind it.
--
-- A CHECK CONSTRAINT EDIT AND NOTHING ELSE, as 0081 was: the rows carry
-- demo_replay's owner policy already, and a kind is a string in a column.
-- ============================================================================

alter table demo_replay drop constraint demo_replay_kind_check;

alter table demo_replay add constraint demo_replay_kind_check
  check (kind in ('matrix', 'progress', 'shadow_verdict', 'board', 'ndcg_ideal', 'llm_ranking'));
