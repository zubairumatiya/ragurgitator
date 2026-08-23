// "Bulk actions → Add nDCG rankings" as a resumable step.
//
// TWO PHASES, so the cursor carries one. Grading builds each ungraded question's
// cross-model aggregate ranking and promotes it to ground truth; scoring then
// re-runs retrieval for the questions that grading just gave a truth to, since
// their nDCG could not have been measured before. A slice can end in either phase,
// so `phase` is part of where-we-got-to just as much as the question id is.
//
// WHY THE CURSOR NEEDS A GRADED COUNT. In the ordinary (non-rebuild) mode the work
// is self-eliminating — a graded question has a truth, so the next slice's pending
// set no longer contains it — and no cursor would be needed at all. In REBUILD mode
// it is not: a rebuilt aggregate is still an aggregate, so recomputing the pending
// set returns the same questions forever. The id cursor is what makes rebuild
// terminate, and the running count is what keeps the progress bar honest across
// slices in both modes.
//
// UNITS ARE QUESTIONS GRADED, not graded-plus-scored. The scoring tail's size is
// not knowable at plan() time (it depends on what grading produces), and padding
// the denominator with a guess would leave every run finishing at "83%". The tail
// reports itself through `message` instead, with the bar full.
import { NEVER_STOP } from "@/lib/http/cancelRegistry";
import type { JobStep } from "@/lib/jobs/types";
import { buildAggregateRanking, setOfficialRanking } from "@/lib/rag/ranking";
import { scoreQuestions, type EvalEvent } from "@/lib/rag/eval";
import {
  allLabeledQuestions,
  createRunSnapshot,
  getSummary,
  questionsNeedingScoring,
} from "@/lib/rag/evalStore";
import { truthKindByQuestion } from "@/lib/rag/rankingStore";

// Grading is 2-wide in the streamed implementation (it fans out to several
// embedding models per question); this batch is the stop-checking granularity,
// not the concurrency.
const GRADE_BATCH = 4;
const SCORE_BATCH = 20;

export type BulkNdcgScope = { documentIds?: string[]; rebuild?: boolean };
export type BulkNdcgCursor = {
  phase: "grade" | "score";
  afterQuestionId: string | null;
  graded: number;
};
export type BulkNdcgResult = {
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
};

export const START: BulkNdcgCursor = { phase: "grade", afterQuestionId: null, graded: 0 };

const byId = (a: { questionId: string }, b: { questionId: string }) =>
  a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0;

// The questions a bulk pass may touch: ungraded ones always, aggregate-truth ones
// only on a rebuild. A manual or LLM ground truth is never overwritten by a bulk
// run — that is a person's decision, and this is a sweep.
async function pendingToGrade(scope: BulkNdcgScope) {
  const questions = (await allLabeledQuestions(scope.documentIds)).sort(byId);
  const truthKinds = await truthKindByQuestion(questions.map((q) => q.questionId));
  return questions.filter((q) => {
    const kind = truthKinds.get(q.questionId);
    if (!kind) return true;
    return Boolean(scope.rebuild) && kind === "aggregate";
  });
}

// What the scoring phase owes: questions whose truth is an aggregate (i.e. one a
// bulk pass produced) and whose stored result is stale or missing. On a rebuild,
// every rebuilt question is re-scored — its ideal moved, so its stored retrieval
// has to be measured against the corpus that produced it.
async function pendingToScore(scope: BulkNdcgScope) {
  const questions = (await allLabeledQuestions(scope.documentIds)).sort(byId);
  const truthKinds = await truthKindByQuestion(questions.map((q) => q.questionId));
  const aggregate = new Set(
    questions.filter((q) => truthKinds.get(q.questionId) === "aggregate").map((q) => q.questionId),
  );
  if (scope.rebuild) return questions.filter((q) => aggregate.has(q.questionId));
  const needing = new Set((await questionsNeedingScoring()).map((q) => q.questionId));
  return questions.filter((q) => aggregate.has(q.questionId) && needing.has(q.questionId));
}

const after = <T extends { questionId: string }>(rows: T[], cursor: string | null): T[] =>
  cursor === null ? rows : rows.filter((r) => r.questionId > cursor);

export const bulkNdcgStep: JobStep<
  BulkNdcgScope,
  BulkNdcgCursor,
  BulkNdcgResult,
  EvalEvent
> = {
  async plan(scope) {
    const pending = await pendingToGrade(scope);
    return { totalUnits: pending.length, cursor: START };
  },

  async run(scope, cursor, emit, shouldStop) {
    const state = cursor ?? START;
    let graded = state.graded;

    if (state.phase === "grade") {
      const pending = after(await pendingToGrade(scope), state.afterQuestionId);
      // The bar's denominator: what this slice starts with, plus what it can still
      // see to do. Fixed for the slice so the bar never moves backwards under it.
      const gradeTotal = graded + pending.length;
      emit({ doneUnits: graded, event: { type: "ranking-start", total: gradeTotal } });

      let last = state.afterQuestionId;
      for (let i = 0; i < pending.length; i += GRADE_BATCH) {
        if (shouldStop()) {
          return {
            cursor: { phase: "grade", afterQuestionId: last, graded },
            done: false,
            doneUnits: graded,
          };
        }
        const batch = pending.slice(i, i + GRADE_BATCH);
        // Sequential within the batch: buildAggregateRanking fans out to several
        // embedding models per question already, so the parallelism that matters
        // is inside it, not around it.
        for (const q of batch) {
          let ok = true;
          let error: string | undefined;
          try {
            const candidate = await buildAggregateRanking(q.questionId);
            if (!(await setOfficialRanking(q.questionId, candidate.id))) {
              throw new Error("Could not promote the ranking to ground truth.");
            }
          } catch (err) {
            // One bad question does not abort the sweep — it is reported and the
            // run moves on, exactly as the streamed version always did.
            ok = false;
            error = err instanceof Error ? err.message : "Ranking build failed.";
          }
          graded += 1;
          last = q.questionId;
          emit({
            doneUnits: graded,
            message: `Graded ${graded} question${graded === 1 ? "" : "s"}`,
            // The failure has to leave the event stream too: in background mode
            // nothing reads `event`, so without this the job counts the question
            // as graded and reports a clean finish (0066).
            failure: ok ? undefined : (error ?? "Ranking build failed."),
            event: {
              type: "ranking-progress",
              done: graded,
              total: gradeTotal,
              questionId: q.questionId,
              ok,
              error,
            },
          });
        }
      }
      // Grading done; the next slice (or the rest of this one) scores.
      return this.run(
        scope,
        { phase: "score", afterQuestionId: null, graded },
        emit,
        shouldStop,
      );
    }

    // --- scoring phase ---
    const toScore = after(await pendingToScore(scope), state.afterQuestionId);
    if (toScore.length === 0) {
      return {
        cursor: { phase: "score", afterQuestionId: state.afterQuestionId, graded },
        done: true,
        doneUnits: graded,
      };
    }
    emit({ doneUnits: graded, event: { type: "score-start", total: toScore.length } });

    let i = 0;
    while (i < toScore.length && !shouldStop()) {
      const batch = toScore.slice(i, i + SCORE_BATCH);
      const offset = i;
      await scoreQuestions(
        batch,
        (event) => {
          if (event.type === "score-start") return;
          if (event.type === "score-result") {
            emit({
              doneUnits: graded,
              message: `Scoring ${offset + event.done} of ${toScore.length} newly graded questions`,
              event: { ...event, done: offset + event.done, total: toScore.length },
            });
            return;
          }
          emit({ doneUnits: graded, event });
        },
        NEVER_STOP,
      );
      i += batch.length;
    }

    return {
      cursor: {
        phase: "score",
        afterQuestionId: i > 0 ? toScore[i - 1].questionId : state.afterQuestionId,
        graded,
      },
      done: i >= toScore.length,
      doneUnits: graded,
    };
  },

  async finalize() {
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
