// AUTOTUNE as a resumable step — the longest bulk action here, and the one that
// most needs to stop being a single unit of durability.
//
// docs/autotune-slicing-plan.md is the argument; the short version is that a run
// used to be one function call, and since 0051 a user scope is one transaction, so
// a 66-minute sweep was a 66-minute transaction. One statement error in its
// closing re-score discarded 22 overrides it had confirmed through real retrieval,
// and the provider calls that produced them stayed billed. Slicing does not
// prevent that error. It bounds one occurrence to a slice.
//
// FOUR PHASES, because the tail is as long as the search and has to slice too.
//
//   search    — one chunk per unit: try sizes, then models, then combos, and
//               confirm the winner through real retrieval (lib/rag/autotune.ts).
//   rescore   — the dirty-set ripple re-score. ~9 minutes at 470 questions, so it
//               is not a finalize(); it is work, and it slices like work.
//   outcomes  — the autotune_runs history row and its per-question before→after.
//   snapshots — the deferred "Models tried" trials (L10), drained last because
//               nothing but a UI list reads them and each is a full model trial.
//
// THE TAIL IS NOT OPTIONAL, which is why the step declares `mustFinish` the
// moment it leaves `search`. By then the run has persisted overrides that changed
// the retrieval fingerprint for the WHOLE corpus, and stopping there would leave
// every other question's stored result silently wrong-under-the-new-state and no
// history row for money that was definitely spent. So a cancel ends the searching
// and the books still get closed — which is exactly what the streamed engine
// always did, now said through the contract instead of through its control flow
// (0067).
//
// WHAT THE CURSOR HAS TO CARRY. Most of a run is recomputed per slice and that is
// the point: targets come from the CURRENT summary, so a chunk that got tuned is
// no longer failing and drops out by itself. Five things are not recoverable that
// way, and the plan's §3 table is where they come from:
//
//   startState / startOverrides  the dirty-set re-score is defined against the
//                                run's STARTING retrieval state; recompute it
//                                per slice and it becomes the state this slice
//                                started in, which proves nothing.
//   gaveUp                       a chunk nothing could improve stays failing
//                                forever, so without this a resumed run
//                                re-attempts the same hopeless chunk every slice.
//   baselines                    frozen before-values. Target MEMBERSHIP must
//                                keep recomputing (that is what makes the work
//                                self-eliminating), but the before-values feed
//                                the outcome rows — recompute those across a
//                                slice boundary and every row compares against a
//                                baseline that has already moved, and the run
//                                reports smaller deltas than it achieved.
//   runId                        so the history row is idempotent: work commits
//                                before the cursor does, so the slice that writes
//                                it can be re-run.
//
// And the fifth is not a cursor field but the reason startOverrides holds
// FINGERPRINTS rather than ids: THE APPLIED SET IS DERIVED, NEVER ACCUMULATED.
// It used to be an in-memory Map of chunks this run applied to. Under "work
// commits before the cursor moves", a crashed slice redoes a chunk whose override
// is already persisted; applyAutotuneCandidate correctly returns 'skipped', the
// map entry is gone, and the chunk never enters the dirty set — so its questions
// keep stale scores. Silently. Diffing live override fingerprints against the
// frozen ones cannot miss that chunk, and also catches the case an id-set diff
// misses: a chunk that had an override and now has a different one.
import { randomUUID } from "node:crypto";

import { NEVER_STOP } from "@/lib/http/cancelRegistry";
import type { JobProgress, JobStep, StopSignal } from "@/lib/jobs/types";
import {
  barsReached,
  drainSnapshot,
  failingMetrics,
  prepareAutotune,
  searchChunk,
  type AutotuneEvent,
  type AutotuneMetric,
  type AutotuneStopReason,
  type PendingSnapshot,
} from "@/lib/rag/autotune";
import { insertAutotuneRun, type AutotuneOutcome } from "@/lib/rag/autotuneStore";
import {
  scoreQuestions,
  screenAffectedQuestions,
  settleAffectedRescore,
  type ChangedChunk,
} from "@/lib/rag/eval";
import type { EvalCriteria } from "@/lib/rag/evalSettingsStore";
import { getSummary, type EvalSummary, type QuestionDetail } from "@/lib/rag/evalStore";
import {
  listOverrides,
  overrideFingerprints,
  retrievalStateFingerprint,
} from "@/lib/rag/overrideStore";

// Same size and the same reason as the re-score step's: big enough that
// scoreQuestions' fixed per-batch setup isn't re-paid per question, small enough
// that a stop is noticed promptly. Stopping is checked BETWEEN batches because
// scoreQuestions' workers claim indices — a mid-batch stop leaves holes no cursor
// could honestly describe.
const RESCORE_BATCH = 20;

// HOW LONG THE STREAMED DRIVER MAY SEARCH (docs/autotune-slicing-plan.md §2).
//
// A property of THAT driver, not of the work: a background job is already bounded
// by its slice deadline and should run to completion however long that takes,
// while a streamed run holds one transaction open for its whole length — which is
// how 2026-08-13's 66-minute run came to lose 22 confirmed overrides, and their
// spend, to a single statement error in its closing re-score.
//
// Truncating is safe because the work is self-eliminating: run it again and it
// continues from where it stopped, no cursor required. 20 minutes is well under
// the 66 that failed and comfortably over an ordinary sweep. Env-tunable, like the
// slice budget it is the sibling of.
export const STREAM_BUDGET_MS = Number(process.env.AUTOTUNE_BUDGET_MS ?? 1_200_000);

// The frozen "before" side of one targeted question's outcome rows. Captured when
// the run first saw the question and never recomputed — see the header.
type FrozenBaseline = {
  chunkId: string;
  metrics: AutotuneMetric[];
  hit: boolean;
  rank: number | null;
  rr: number | null;
  ndcg: number | null;
};

export type AutotuneScope = Record<string, never>;

export type AutotuneCursor = {
  phase: "search" | "rescore" | "outcomes" | "snapshots";
  runId: string;
  startState: string;
  startOverrides: Record<string, string>; // chunk id → override fingerprint at run start
  baselines: Record<string, FrozenBaseline>; // question id → frozen before-values
  gaveUp: string[];
  searched: number;
  chunksTotal: number;
  attempts: number;
  pendingChoice: number;
  stopReason: AutotuneStopReason | null;
  snapshots: PendingSnapshot[];
  // How many questions the previous re-score pass found dirty. The phase has no
  // cursor of its own — it re-screens and the set drains — so this is the only
  // thing standing between it and an infinite loop if a question can never come
  // back clean. See runRescore.
  lastDirty: number | null;
};

export type AutotuneResult = {
  targeted: number;
  resolved: number;
  unresolved: number;
  improved: number;
  pendingChoice: number;
  attempts: number;
  chunksSearched: number;
  chunksTotal: number;
  stopReason: AutotuneStopReason | null;
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
};

type Emit = (progress: JobProgress<AutotuneEvent>) => void;

const pairValue = (q: QuestionDetail, metric: AutotuneMetric): number =>
  metric === "recall" ? (q.hit ? 1 : 0) : metric === "mrr" ? (q.rr ?? 0) : (q.ndcg ?? 0);

const beforeValue = (b: FrozenBaseline, metric: AutotuneMetric): number | null =>
  metric === "recall" ? (b.hit ? 1 : 0) : metric === "mrr" ? b.rr : b.ndcg;

// The chunks whose override differs from the run's start — the dirty-set
// re-score's input, and the one thing in this file that is DERIVED rather than
// remembered. Covers all three ways a chunk can differ: gained an override,
// changed to a different one, or (a revert past the run's start) lost it.
async function changedChunks(startOverrides: Record<string, string>): Promise<ChangedChunk[]> {
  const live = await overrideFingerprints();
  const models = new Map((await listOverrides()).map((o) => [o.sourceChunkId, o.model]));
  const ids = new Set([...Object.keys(startOverrides), ...live.keys()]);
  const changed: ChangedChunk[] = [];
  for (const id of ids) {
    if (live.get(id) === startOverrides[id]) continue;
    changed.push({
      chunkId: id,
      finalModel: models.get(id) ?? null,
      startOverridden: id in startOverrides,
    });
  }
  return changed;
}

export const autotuneStep: JobStep<
  AutotuneScope,
  AutotuneCursor,
  AutotuneResult,
  AutotuneEvent
> = {
  // Counts the chunks a run would visit, and freezes everything the header calls
  // un-recomputable. Reads only — it is also what the ETA route calls, which is
  // why the frozen values are captured here rather than written anywhere.
  async plan() {
    const cursor = await freshCursor();
    return { totalUnits: cursor.chunksTotal, cursor };
  },

  async run(_scope, cursor, emit, shouldStop) {
    // A job created without one (the smoke harness writes ledger rows directly)
    // freezes its run-start state here instead — later than launch, but still
    // before the first chunk is touched, which is the property that matters.
    const c = cursor ?? (await freshCursor());
    if (c.phase === "search") return runSearch(c, emit, shouldStop);
    if (c.phase === "rescore") return runRescore(c, emit, shouldStop);
    if (c.phase === "outcomes") return runOutcomes(c, emit);
    return runSnapshots(c, emit, shouldStop);
  },

  // Only the headline numbers — every durable effect already happened in a phase,
  // so this is safe to skip and safe to repeat.
  async finalize(_scope, cursor) {
    const summary = await getSummary();
    const { resolved, improved } = tally(cursor.baselines, summary);
    const targeted = Object.keys(cursor.baselines).length;
    return {
      targeted,
      resolved,
      unresolved: targeted - resolved,
      improved,
      pendingChoice: cursor.pendingChoice,
      attempts: cursor.attempts,
      chunksSearched: cursor.searched,
      chunksTotal: cursor.chunksTotal,
      stopReason: cursor.stopReason,
      recall: summary.recall,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
    };
  },
};

// The run's starting point, and the only place its un-recomputable values are
// captured. Reads only — it is also what the ETA route reaches through plan().
async function freshCursor(): Promise<AutotuneCursor> {
  const prepared = await prepareAutotune();
  const cursor: AutotuneCursor = {
    phase: "search",
    runId: randomUUID(),
    startState: await retrievalStateFingerprint(),
    startOverrides: Object.fromEntries(await overrideFingerprints()),
    baselines: {},
    gaveUp: [],
    searched: 0,
    chunksTotal: prepared.ok ? prepared.orderedChunks.length : 0,
    attempts: 0,
    pendingChoice: 0,
    stopReason: null,
    snapshots: [],
    lastDirty: null,
  };
  if (!prepared.ok) return cursor;
  for (const t of prepared.targets) {
    cursor.baselines[t.questionId] = {
      chunkId: t.sourceChunkId,
      metrics: t.metrics,
      hit: t.beforeHit,
      rank: t.beforeRank,
      rr: t.beforeRr,
      ndcg: t.beforeNdcg,
    };
  }
  return cursor;
}

// How the run did, per targeted question: resolved (nothing it was targeted for
// is failing any more) or merely improved (still below the bar, but a targeted
// metric's value rose). Against the FROZEN baseline, which is the whole point of
// carrying one — recompute the before-values across a slice boundary and every
// delta is measured from a line that has already moved.
//
// The bars themselves are read live from the summary's criteria rather than
// frozen: they are the user's settings, and "is this question below its bar" is a
// question about what the bar is, not what it was.
function tally(
  baselines: Record<string, FrozenBaseline>,
  summary: Pick<EvalSummary, "questions" | "criteria">,
): { resolved: number; improved: number; after: Map<string, QuestionDetail> } {
  const after = new Map(summary.questions.map((q) => [q.questionId, q]));
  let resolved = 0;
  let improved = 0;
  for (const [questionId, b] of Object.entries(baselines)) {
    const q = after.get(questionId);
    const stillFailing = q ? failingMetrics(q, summary.criteria as EvalCriteria) : b.metrics;
    if (stillFailing.length === 0) resolved += 1;
    else if (q && b.metrics.some((m) => pairValue(q, m) > (beforeValue(b, m) ?? 0) + 1e-9)) {
      improved += 1;
    }
  }
  return { resolved, improved, after };
}

// --- phase 1: search --------------------------------------------------------

async function runSearch(c: AutotuneCursor, emit: Emit, shouldStop: StopSignal) {
  const prepared = await prepareAutotune();
  if (!prepared.ok) {
    emit({ doneUnits: c.searched, event: { type: "error", message: prepared.error } });
    // Before the first chunk this is just "there is nothing to target" — no
    // overrides changed, so the tail would write an empty history row against an
    // unchanged corpus. After it, the criteria were edited mid-run: the searching
    // is over but the books still have to close on what it already spent.
    if (c.searched === 0) return { cursor: c, done: true, doneUnits: 0 };
    return {
      cursor: { ...c, phase: "rescore" as const },
      done: false,
      doneUnits: c.searched,
      mustFinish: true,
    };
  }
  const { prep, orderedChunks } = prepared;
  const gaveUp = new Set(c.gaveUp);

  // First slice only: the run's shape, once, with the totals it started from.
  if (c.searched === 0 && gaveUp.size === 0) {
    emit({
      doneUnits: 0,
      event: {
        type: "autotune-start",
        targeted: prepared.targets.length,
        chunks: orderedChunks.length,
        search: prep.search,
        apply: prep.applyMode,
      },
    });
  }

  // Newly seen targets get a frozen baseline too: a question can start failing
  // between slices (a neighbouring override moved it), and it is a target of this
  // run from the moment the run first sees it.
  for (const t of prepared.targets) {
    if (!(t.questionId in c.baselines)) {
      c.baselines[t.questionId] = {
        chunkId: t.sourceChunkId,
        metrics: t.metrics,
        hit: t.beforeHit,
        rank: t.beforeRank,
        rr: t.beforeRr,
        ndcg: t.beforeNdcg,
      };
    }
  }

  const todo = orderedChunks.filter(([id]) => !gaveUp.has(id));
  let rates = prepared.rates;
  let searched = c.searched;
  let attempts = c.attempts;
  let pendingChoice = c.pendingChoice;
  let index = 0;

  for (const [chunkId, chunkTargets] of todo) {
    if (prep.stopEarly && barsReached(prep, rates)) {
      emit({
        doneUnits: searched,
        event: {
          type: "early-stop",
          skippedChunks: todo.length - index,
          ...rates,
        },
      });
      c.stopReason = "early";
      break;
    }
    // Between chunks, i.e. between searches — the only point where state is
    // consistent, since nothing is persisted mid-search.
    //
    // WHY the stop matters here and nowhere else. A deadline means another slice
    // is coming, so the cursor stays in `search` and the next one recomputes what
    // is left. A cancel or a budget means no more searching will happen at all —
    // and the overrides confirmed so far have already moved the retrieval
    // fingerprint for the whole corpus, so the run must fall through to its tail
    // rather than stop here with the books open.
    if (shouldStop()) {
      const why = shouldStop.reason?.() ?? "deadline";
      if (why === "deadline") {
        return {
          cursor: { ...c, searched, attempts, pendingChoice, gaveUp: [...gaveUp] },
          done: false,
          doneUnits: searched,
        };
      }
      if (why === "budget") {
        emit({
          doneUnits: searched,
          event: {
            type: "budget-stop",
            searchedChunks: searched,
            skippedChunks: todo.length - index,
            elapsedMs: STREAM_BUDGET_MS,
          },
        });
      }
      c.stopReason = why === "budget" ? "budget" : "cancelled";
      break;
    }
    index += 1;
    emit({
      doneUnits: searched,
      message: `Tuning chunk ${searched + 1} of ${c.chunksTotal}`,
      event: {
        type: "chunk-start",
        chunkId,
        fileName: chunkTargets[0].fileName,
        position: chunkTargets[0].position,
        index: searched + 1,
        total: c.chunksTotal,
        questions: chunkTargets.length,
      },
    });

    let result;
    try {
      result = await searchChunk(prep, chunkId, chunkTargets, (event) =>
        emit({ doneUnits: searched, event }),
      );
    } catch (err) {
      // One chunk's search failing must not end the sweep — the chunks already
      // confirmed are committed and the rest are still worth trying. Recorded as a
      // failed unit so a job that finishes with holes says so (0066).
      const message = err instanceof Error ? err.message : "Chunk search failed.";
      emit({
        doneUnits: searched + 1,
        failure: message,
        event: { type: "chunk-unresolved", chunkId, reason: message },
      });
      gaveUp.add(chunkId);
      searched += 1;
      continue;
    }

    attempts += result.attempts;
    pendingChoice += result.pendingChoice;
    searched += 1;
    if (result.snapshot) c.snapshots.push(result.snapshot);
    // A chunk that resolved or improved drops out of the next slice's targets by
    // itself. One that did not is still failing and would be retried forever, so
    // it is written down. 'choice' likewise: its decision is the user's, and the
    // run has nothing further to try on it.
    if (result.status === "unresolved" || result.status === "choice") gaveUp.add(chunkId);
    if (prep.stopEarly && result.kept) {
      const s = await getSummary();
      rates = { recall: s.recall, mrr: s.mrr, ndcg: s.ndcg };
    }
  }

  // Out of chunks (or stopped early): the search is over and the tail begins.
  return {
    cursor: {
      ...c,
      phase: "rescore" as const,
      searched,
      attempts,
      pendingChoice,
      gaveUp: [...gaveUp],
    },
    done: false,
    doneUnits: searched,
    mustFinish: true,
  };
}

// --- phase 2: the dirty-set re-score ----------------------------------------

async function runRescore(c: AutotuneCursor, emit: Emit, shouldStop: () => boolean) {
  const changed = await changedChunks(c.startOverrides);
  const screen = await screenAffectedQuestions(changed, c.startState);

  // The phase drains its own work, so "am I finished" is "is anything still
  // dirty" — with one guard. A question that cannot come back clean (its score
  // keeps landing under a fingerprint the screen still rejects) would otherwise
  // re-score forever, and in the streamed driver there is no deadline to stop it
  // because mustFinish has already switched the budget off. A pass that scores
  // everything it found and does not shrink the set is not going to.
  const stuck = c.lastDirty !== null && screen.dirty.length >= c.lastDirty;
  if (stuck) {
    console.warn(
      `[rag:autotune] re-score made no progress at ${screen.dirty.length} dirty ` +
        `question(s); settling anyway`,
    );
  }

  if (screen.dirty.length === 0 || stuck) {
    // Nothing left dirty: stamp the proven-clean rows, drop the change log and
    // freeze the snapshot. Idempotent, so a slice that dies here simply redoes it.
    await settleAffectedRescore(screen, c.startState);
    return {
      cursor: { ...c, phase: "outcomes" as const },
      done: false,
      doneUnits: c.searched,
      mustFinish: true,
    };
  }

  // No cursor of its own: a question scored under the final state drops out of the
  // next screen, so the phase eliminates its own work exactly like the search does.
  emit({ doneUnits: c.searched, event: { type: "rescore-start", total: screen.dirty.length } });
  let i = 0;
  while (i < screen.dirty.length && !shouldStop()) {
    const batch = screen.dirty.slice(i, i + RESCORE_BATCH);
    const offset = i;
    await scoreQuestions(
      batch,
      (event) => {
        if (event.type === "score-result") {
          emit({
            doneUnits: c.searched,
            message: `Re-scoring ${offset + event.done} of ${screen.dirty.length} affected questions`,
            event: {
              type: "rescore-progress",
              done: offset + event.done,
              total: screen.dirty.length,
            },
          });
        }
      },
      NEVER_STOP,
    );
    i += batch.length;
  }

  // Only counts as a pass when the slice got through the whole set — a slice cut
  // short by its deadline has a smaller `i` for a reason that says nothing about
  // whether the work is making progress.
  const lastDirty = i >= screen.dirty.length ? screen.dirty.length : c.lastDirty;
  return { cursor: { ...c, lastDirty }, done: false, doneUnits: c.searched, mustFinish: true };
}

// --- phase 3: the history row -----------------------------------------------

async function runOutcomes(c: AutotuneCursor, emit: Emit) {
  const prepared = await prepareAutotune();
  const summary = await getSummary();
  const { resolved, improved, after: afterByQ } = tally(c.baselines, summary);

  // Which chunks THIS run changed, and what they ended up with — both read back
  // from the override rows rather than from anything the run remembered doing.
  const changed = new Set((await changedChunks(c.startOverrides)).map((x) => x.chunkId));
  const endOverrides = new Map((await listOverrides()).map((o) => [o.sourceChunkId, o]));
  // The one attributed field the rows cannot answer: an override row stores its
  // pieces, not the target token size the candidate was chosen at. The kept
  // candidates are on the cursor (they are queued for their trial snapshots), so
  // they survive slicing too.
  const appliedSize = new Map(c.snapshots.map((s) => [s.chunkId, s.size]));

  const outcomes: AutotuneOutcome[] = [];
  for (const [questionId, b] of Object.entries(c.baselines)) {
    const after = afterByQ.get(questionId);
    const ov = changed.has(b.chunkId) ? (endOverrides.get(b.chunkId) ?? null) : null;
    for (const m of b.metrics) {
      outcomes.push({
        questionId,
        sourceChunkId: b.chunkId,
        metric: m,
        beforeValue: beforeValue(b, m),
        beforeRank: b.rank,
        afterValue: after === undefined ? null : afterValue(after, m),
        afterRank: after?.foundRank ?? null,
        overrideKind: ov?.kind ?? null,
        overrideModel: ov?.model ?? null,
        overrideSize: ov ? (appliedSize.get(b.chunkId) ?? null) : null,
      });
    }
  }

  const targeted = Object.keys(c.baselines).length;
  const crit = prepared.ok ? prepared.prep : null;
  await insertAutotuneRun(
    c.runId,
    {
      recallK: crit?.recallTargeting ? crit.bars.recallK : null,
      recallMinRate: crit?.criteria.recall.minRate ?? null,
      mrrK: crit?.mrrTargeting ? crit.bars.mrrK : null,
      mrrMinRate: crit?.criteria.mrr.minRate ?? null,
      ndcgK: crit?.ndcgTargeting ? crit.bars.ndcgK : null,
      ndcgMinRate: crit?.criteria.ndcg.minRate ?? null,
      targeted,
      resolved,
      unresolved: targeted - resolved,
      improved,
      attempts: c.attempts,
      stopReason: c.stopReason,
      chunksTotal: c.chunksTotal,
      chunksSearched: c.searched,
    },
    outcomes,
  );
  console.log(
    `[rag:autotune] books closed: targeted=${targeted} resolved=${resolved} improved=${improved} ` +
      `chunks=${c.searched}/${c.chunksTotal} stop=${c.stopReason ?? "complete"} ` +
      `attempts=${c.attempts} pendingChoice=${c.pendingChoice}`,
  );
  emit({ doneUnits: c.searched, message: "Recording results" });
  return {
    cursor: { ...c, phase: "snapshots" as const },
    done: false,
    doneUnits: c.searched,
    mustFinish: true,
  };
}

const afterValue = (q: QuestionDetail, m: AutotuneMetric): number | null =>
  m === "recall" ? (q.hit === null ? null : q.hit ? 1 : 0) : m === "mrr" ? q.rr : q.ndcg;

// --- phase 4: the deferred trial snapshots ----------------------------------

// L10: each of these re-runs a FULL model trial (re-chunk, re-embed, re-rank the
// pool) purely to populate the chunk's "Models tried" list — 97.6s across a run,
// 41% of confirm, and nothing inside a run reads eval_model_trials back. Last, so
// the run's RESULT never waits on bookkeeping, and sliced like everything else so
// a long list cannot overrun the deadline in one go.
async function runSnapshots(c: AutotuneCursor, emit: Emit, shouldStop: () => boolean) {
  const left = [...c.snapshots];
  while (left.length > 0 && !shouldStop()) {
    await drainSnapshot(left[0]);
    left.shift();
    emit({ doneUnits: c.searched, message: `Saving trials (${left.length} left)` });
  }
  return {
    cursor: { ...c, snapshots: left },
    done: left.length === 0,
    doneUnits: c.searched,
    mustFinish: true,
  };
}
