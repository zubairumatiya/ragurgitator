// "Re-score all questions" as a resumable step.
//
// The work itself is unchanged — allLabeledQuestions + scoreQuestions, exactly what
// rescoreAllQuestions always did. What is new is that it can stop after any batch
// and pick up where it left off in another process, which is what lets the same
// implementation serve both the streaming route and a background job.
//
// THE CURSOR IS A QUESTION ID, NOT AN INDEX. allLabeledQuestions has no ORDER BY,
// so its row order is not a thing to count into: two slices could see the same set
// in different orders and an index would silently mean two different places. Each
// slice therefore sorts by question id (a total order over the set) and resumes at
// the first id after the one stored. That is also stable under insertion — a
// question added mid-run appears in a later slice's list but never shifts what
// "after this id" means.
//
// BATCHES ARE ATOMIC WITH RESPECT TO STOPPING. shouldStop is checked BETWEEN
// batches and the batch itself runs with NEVER_STOP, so a batch is either fully
// attempted or not started. Stopping mid-batch would leave scoreQuestions' holes
// (its workers stop claiming indices, so which questions landed is not positional)
// and the cursor could not honestly say where we got to. The cost is that a
// deadline or a cancel is noticed up to one batch late — seconds, at this size.
import { NEVER_STOP } from "@/lib/http/cancelRegistry";
import type { JobStep } from "@/lib/jobs/types";
import { scoreQuestions, type EvalEvent } from "@/lib/rag/eval";
import { allLabeledQuestions, createRunSnapshot, getSummary } from "@/lib/rag/evalStore";
import { clearRetrievalChanges } from "@/lib/rag/overrideStore";

// Small enough that a stop is noticed promptly, large enough that scoreQuestions'
// fixed per-batch setup (four parallel reads, one embedding-cost meter) is not
// re-paid per question. SCORE_CONCURRENCY is 4, so this is five waves.
const BATCH = 20;

export type RescoreScope = { documentIds?: string[] };
export type RescoreCursor = { afterQuestionId: string | null };
// The CONFIG's metrics after the run, not this run's — a snapshot is config-wide
// by definition, and a document-scoped re-score still moves the whole config's
// numbers. Deliberately does NOT carry a "scored" count: getSummary().scored is
// every scored question in the config, which next to a document-scoped job's own
// unit count reads as a contradiction. How much this run did is job.doneUnits.
export type RescoreResult = {
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
};

const byId = (a: { questionId: string }, b: { questionId: string }) =>
  a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0;

export const START: RescoreCursor = { afterQuestionId: null };

export const rescoreStep: JobStep<RescoreScope, RescoreCursor, RescoreResult, EvalEvent> = {
  async plan(scope) {
    const questions = await allLabeledQuestions(scope.documentIds);
    return { totalUnits: questions.length, cursor: START };
  },

  async run(scope, cursor, emit, shouldStop) {
    const all = (await allLabeledQuestions(scope.documentIds)).sort(byId);
    const after = cursor?.afterQuestionId ?? null;
    // Where this slice starts: the first question after the stored id. A cursor
    // pointing past everything (the set shrank) resolves to "nothing left", which
    // is the right answer rather than an error.
    let i = after === null ? 0 : all.findIndex((q) => q.questionId > after);
    if (i < 0) i = all.length;

    // Sizes the dashboard's bar to the WHOLE job, not to this slice — the
    // per-batch score-start events below are suppressed for the same reason.
    emit({ doneUnits: i, event: { type: "score-start", total: all.length } });

    while (i < all.length && !shouldStop()) {
      const batch = all.slice(i, i + BATCH);
      const offset = i;
      await scoreQuestions(
        batch,
        (event) => {
          // Re-base the batch's own counters onto the run's totals, and drop its
          // score-start (already emitted above with the real total).
          if (event.type === "score-start") return;
          if (event.type === "score-result") {
            emit({
              doneUnits: offset + event.done,
              message: `Scored ${offset + event.done} of ${all.length} questions`,
              event: { ...event, done: offset + event.done, total: all.length },
            });
            return;
          }
          emit({ doneUnits: offset, event });
        },
        NEVER_STOP,
      );
      i += batch.length;
    }

    return {
      cursor: { afterQuestionId: i > 0 ? all[i - 1].questionId : null },
      done: i >= all.length,
      doneUnits: i,
    };
  },

  // The once-per-job tail, unchanged from rescoreAllQuestions: an unscoped re-score
  // has refreshed every result, so the stale badge's change log can be cleared; a
  // document-scoped one leaves other documents' stale rows (and their badge) alone.
  // Only reached when the job ran to completion — the runner skips finalize on
  // cancel, which is what keeps a partial re-score from clearing a log it did not
  // earn.
  async finalize(scope) {
    if (!scope.documentIds || scope.documentIds.length === 0) {
      await clearRetrievalChanges();
    }
    const summary = await getSummary();
    if (summary.scored > 0) {
      await createRunSnapshot({
        questionCount: summary.scored,
        hitCount: summary.hits,
        mrr: summary.mrr,
        ndcg: summary.ndcg,
        ndcgCovered: summary.ndcgCovered,
        k: summary.recallK,
      });
    }
    return { recall: summary.recall, mrr: summary.mrr, ndcg: summary.ndcg };
  },
};
