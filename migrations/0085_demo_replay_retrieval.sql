-- ============================================================================
-- 0085_demo_replay_retrieval.sql
--
-- docs/demo-retrieval-bank-plan.md §3.2: an eighth `demo_replay` kind.
--
--   kind='retrieval'  one row per PORTABLE RETRIEVAL KEY (lib/rag/overrideStore
--                     portableRetrievalKey): for every question the publish's
--                     walk scored under that override state, the ranked list
--                     retrieval returned — chunk ids in rank order, their
--                     scores, and the screen cutoffs the result was judged at.
--
-- WHY IT IS BANKED. After the tuning shelf (0083) a guest's ⚙ press makes zero
-- provider calls and still takes ~100 s, and Score pending ~28 s: every second
-- of it is RETRIEVAL, and it is retrieval the demo has already done. Every
-- question a guest can hold came from the publish's bank, every override a
-- press can install came from the publish's bank, and the corpus is a
-- byte-for-byte clone — so the ranked list a guest's re-score computes is one
-- the publish could have computed for them. This kind holds those lists.
--
-- KEYED BY EXACTLY WHAT DETERMINES A RANK, which is what keeps it honest where
-- banking the master's post-autotune NUMBERS would not be (the option
-- docs/demo-rescore-replay-plan.md §2 rejected): the key is the 0022 retrieval
-- fingerprint with chunk ROW ids replaced by chunk TEXT hashes, so it names an
-- override SET rather than a workspace, and the question is named by a hash of
-- its wording. A board that reaches an override set the publish never walked,
-- or a question whose text was edited, has no entry and is computed exactly as
-- today. A hit is exact — given identical state, retrieval is deterministic.
--
-- THE LISTS ARE RANKINGS, so clone step 5l holds an unmappable element's place
-- as null (the 0082 rule, not the board's), and the reader treats ANY null in a
-- list as a miss for that question: a rank with a hole is not the rank.
--
-- ON THE MASTER AND THE SNAPSHOT the ids are stored as sha256(chunk text)
-- (`form: 'hash'`), which names nothing and so can be recorded from any
-- throwaway workspace; the clone rewrites them into the destination's ids
-- (`form: 'id'`) on the first hop that lands them in a guest.
--
-- A CHECK CONSTRAINT EDIT AND NOTHING ELSE, as 0081–0083 were.
-- ============================================================================

alter table demo_replay drop constraint demo_replay_kind_check;

alter table demo_replay add constraint demo_replay_kind_check
  check (kind in ('matrix', 'progress', 'shadow_verdict', 'board', 'ndcg_ideal',
                  'llm_ranking', 'tuning', 'retrieval'));
