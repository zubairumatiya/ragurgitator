// The rate reduction, and the one place that knows how a HUMAN'S ignore differs
// from a DRAWN holdout.
//
// This used to live inside evalStore.reduceMetrics, which is a server module: it
// imports `sql`. That was fine while the only consumer was the dashboard summary,
// and stopped being fine the moment the live train/holdout split had to be
// computed on the client from rows it has already fetched. Rather than write the
// arithmetic a second time — which is exactly how a delta becomes an artefact of
// which copy computed it — the reduction moved here, importing nothing, and
// evalStore calls it.
//
// THE PARTITION IS THE POINT. `ignored` is a union of two unrelated facts:
//
//   a human clicked "ignore in rates"   — this question is noise, it should not
//                                         count anywhere, on either side
//   the holdout draw picked it (0061)   — this question is a real measurement,
//                                         deliberately withheld from the rates
//                                         the tuner optimises against
//
// Collapsing them is what makes a holdout number impossible to compute from the
// dashboard, and special-casing `heldOut` inside the rate function would make the
// two inseparable in the other direction: a human ignore would start counting
// toward the holdout. So the caller names the side it wants and the rule for each
// side is written once, here.

// The fields a rate needs. Structural rather than an import of QuestionDetail, so
// this module stays dependency-free — QuestionDetail satisfies it, and so does
// any future row shape that carries the same six facts.
export type RateRow = {
  questionId: string;
  hit: boolean | null;
  // Edited since its last score: the stored result belongs to the OLD text, so it
  // is pending rather than countable. Identical to membership of the
  // `editStaleIds` set mapQuestionDetails builds — same flag, carried on the row.
  editStale: boolean;
  rr: number | null;
  ndcg: number | null;
  ignored: boolean;
  heldOut: boolean;
};

// `rated` is the dashboard's headline set: everything a human has not excluded,
// which — because the draw writes its picks as ignores — already excludes the
// holdout. `train` is its synonym, named for the reader of a split rather than
// for the reader of a headline; keeping both is cheap and stops "train" from
// being silently redefined later.
export type RatePartition = "rated" | "train" | "holdout";

export function inPartition(q: RateRow, partition: RatePartition): boolean {
  // Held out: exactly the drawn set. A human ignore is not in it, which is the
  // whole reason `heldOut` is a separate flag and not `ignored && something`.
  if (partition === "holdout") return q.heldOut;
  return !q.ignored;
}

export type Rates = {
  hits: number;
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
  ndcgCovered: number;
};

// Rates over one partition. Kept generic so callers get their own row type back
// out of `scoredRows` — getSummary hands the live subset of QuestionDetail rows
// on to the baseline comparison and must not lose the extra fields on the way.
export function reduceRates<T extends RateRow>(
  questions: readonly T[],
  partition: RatePartition = "rated",
): Rates & { scoredRows: T[] } {
  const inSide = questions.filter((q) => inPartition(q, partition));

  // Scored rows count toward recall — including retrieval-stale ones (badged,
  // approximate until the next run). Unscored and edit-stale are pending.
  const scoredRows = inSide.filter((q) => q.hit !== null && !q.editStale);
  const hits = scoredRows.filter((q) => q.hit === true).length;

  // MRR@mrr_k over the same scored set, from the per-question rr (single-relevant)
  // — no extra retrieval, so already-scored questions are covered retroactively.
  const mrr =
    scoredRows.length > 0
      ? scoredRows.reduce((sum, q) => sum + (q.rr ?? 0), 0) / scoredRows.length
      : null;

  // Mean graded nDCG over exactly the questions that have one (ranked + freshly
  // scored). ndcgCovered is that set's size — the dashboard's 5/n.
  const graded = inSide.map((q) => q.ndcg).filter((v): v is number => v !== null);
  const ndcg = graded.length > 0 ? graded.reduce((s, v) => s + v, 0) / graded.length : null;

  return {
    scoredRows,
    hits,
    recall: scoredRows.length > 0 ? hits / scoredRows.length : null,
    mrr,
    ndcg,
    ndcgCovered: graded.length,
  };
}

// One question's three metrics, in the shape both the frozen before-values and
// the read-back after-values take.
export type SplitPoint = {
  n: number;
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
};

export type Split = { train: SplitPoint; holdout: SplitPoint };

// Both sides in one call, because a holdout rate is not a thing anyone may
// compute on its own — see the migration header. Every surface that shows a
// holdout number gets its train number from the same pass over the same rows.
export function splitRates(questions: readonly RateRow[]): Split {
  const side = (partition: RatePartition): SplitPoint => {
    const r = reduceRates(questions, partition);
    return { n: r.scoredRows.length, recall: r.recall, mrr: r.mrr, ndcg: r.ndcg };
  };
  return { train: side("train"), holdout: side("holdout") };
}

// The split over a NAMED membership rather than over today's `heldOut` flags.
//
// A run freezes its members at plan time and closes its books minutes to hours
// later, and in between the draw can be redrawn from Settings. Reading the live
// flags at both ends would then compare a before over one test set against an
// after over another and print the difference as a result. So the run's own
// numbers are always computed against the ids it froze.
//
// Two rewrites do it, and both matter:
//   heldOut ← membership       a question released from the holdout mid-run stops
//                              counting on the holdout side.
//   ignored ← ignored OR member  …and does not silently reappear on the train
//                              side, which would put one question on both.
//
// A question drawn INTO the holdout mid-run is `ignored` in the rows and not in
// `members`, so it lands on neither side. That shrinks the train denominator
// slightly and is the honest answer: it is not a member of this run's test set,
// and it is no longer part of what the run was optimising against either.
export function splitRatesFor(
  questions: readonly RateRow[],
  members: ReadonlySet<string>,
): Split {
  return splitRates(
    questions.map((q) => {
      const member = members.has(q.questionId);
      return { ...q, heldOut: member, ignored: q.ignored || member };
    }),
  );
}
