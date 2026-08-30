// BANKING THE TWO RANKINGS THE DEMO'S EVAL TAB MAY NOT BUY — phase 5 of
// docs/demo-real-flow-plan.md.
//
// Steps 4 and 5 of the walk are "Add nDCG rankings" and "Add LLM nDCG rankings".
// The first embeds a 30-chunk candidate pool under every model on the aggregate
// list, per question; the second spends one answer-model call per question.
// Neither is affordable per visitor, and both are already PAID FOR on the master
// — the ideals for all 472 of its questions, and the llm_rerank orders as of this
// phase. So the publish copies them onto the shelf lib/demo/replay owns, and a
// guest's press applies a copy instead of calling a provider.
//
// WHAT IS NOT BANKED IS THE GRADING. ndcg(ideal, retrieved_ids, k) runs over the
// visitor's own retrieval in their own workspace, exactly as it does for a real
// account — the ideal is the master's, the ordering being graded is theirs. That
// is the demo's best moment and the reason only the RANKING travels.
//
// THIS MODULE READS THE MASTER, through privilegedSql like every other
// publish-time step in scripts/demo-snapshot: a script has no request scope, so
// the request-scoped `sql` would throw before it read. The one thing here that
// does need a scope is BUYING the llm_rerank rows, and that is deliberately not
// here — it is buildLlmRanking, called by the script inside the master's own
// withUser/withConfig block, exactly as the sweep and the replay are.
import "server-only";

import { privilegedSql } from "@/lib/db";
import { questionIdentity, type ReplayRankings } from "@/lib/demo/replayCore";

// One question the walk can reach: it is labeled to a chunk on the published
// board, so the bank can hand its wording out and a guest's press will mint a
// row carrying that exact text.
export type BoardQuestion = {
  questionId: string;
  question: string;
  // Whether the master already holds this question's ranking of the kind being
  // captured. For the ideals it is true for every question by construction; for
  // llm_rerank it is what the publish has to BUY, and the count is the number an
  // operator sees before typing --yes.
  hasRanking: boolean;
};

// EVERY LABELED QUESTION ON THE BOARD, not just the ~60 the bank will pick.
//
// The bank's selection runs later and on the SNAPSHOT (one per chunk and
// difficulty, ordered by md5 of a snapshot id), so it cannot be predicted from
// here — and a shelf missing the one question the bank happened to choose is a
// step that refuses in front of a visitor. The superset is ~2 questions per board
// chunk on today's corpus, which is the same order of magnitude, so banking it
// whole is cheaper than keeping two selectors in agreement.
async function boardQuestions(
  configId: string,
  board: string[],
  kind: "aggregate-truth" | "llm_rerank",
): Promise<BoardQuestion[]> {
  if (board.length === 0) return [];
  const rows = await privilegedSql<{ id: string; question: string; ranked: boolean }[]>`
    select q.id::text as id,
           q.question,
           exists (
             select 1 from eval_rankings rk
              where rk.eval_question_id = q.id
                and rk.document_embedding_id = l.document_embedding_id
                and ${kind === "llm_rerank" ? privilegedSql`rk.kind = 'llm_rerank'` : privilegedSql`rk.is_truth`}
           ) as ranked
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      join eval_questions q on q.id = l.eval_question_id
     where de.config_id = ${configId}
       and l.source_chunk_id = any(${board}::uuid[])
     order by q.id
  `;
  return rows.map((r) => ({ questionId: r.id, question: r.question, hasRanking: r.ranked }));
}

export const idealCensus = (configId: string, board: string[]): Promise<BoardQuestion[]> =>
  boardQuestions(configId, board, "aggregate-truth");

export const llmRankingCensus = (configId: string, board: string[]): Promise<BoardQuestion[]> =>
  boardQuestions(configId, board, "llm_rerank");

// The banked form of one kind. `is_truth` for the ideals rather than
// `kind = 'aggregate'`: what step 4 replays is the question's GROUND TRUTH, which
// is what the guest's nDCG will then be scored against, and on the master that is
// an aggregate for every question the demo can reach but is not required to be.
//
// DEDUPED BY WORDING, first row wins. The key is the question text (0082), so two
// master questions phrased identically are one entry — and they are also one
// question to the bank, which keys question_cache by (text_hash, difficulty).
async function packRankings(
  configId: string,
  board: string[],
  where: "is_truth" | "llm_rerank",
): Promise<ReplayRankings> {
  if (board.length === 0) return { version: 1, entries: [] };
  const rows = await privilegedSql<{ question: string; chunk_ids: (string | null)[] }[]>`
    select q.question, rk.chunk_ids
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
      join eval_questions q on q.id = l.eval_question_id
      join eval_rankings rk on rk.eval_question_id = q.id
                           and rk.document_embedding_id = l.document_embedding_id
                           and ${where === "is_truth" ? privilegedSql`rk.is_truth` : privilegedSql`rk.kind = 'llm_rerank'`}
     where de.config_id = ${configId}
       and l.source_chunk_id = any(${board}::uuid[])
     order by q.id
  `;
  const entries = new Map<string, (string | null)[]>();
  for (const r of rows) {
    const q = questionIdentity(r.question);
    if (!entries.has(q)) entries.set(q, r.chunk_ids ?? []);
  }
  return { version: 1, entries: [...entries].map(([q, order]) => ({ q, order })) };
}

export const packIdeals = (configId: string, board: string[]): Promise<ReplayRankings> =>
  packRankings(configId, board, "is_truth");

export const packLlmRankings = (configId: string, board: string[]): Promise<ReplayRankings> =>
  packRankings(configId, board, "llm_rerank");
