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
// FIVE PHASES, because the tail is as long as the search and has to slice too.
//
//   settle    — re-score a corpus somebody else left stale, BEFORE freezing a plan
//               against it. Skipped entirely when nothing is stale, which is the
//               normal case. See runSettle for why it has to come first.
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
// WHAT THE CURSOR HAS TO CARRY, and the one thing it got wrong for a while.
//
// The original design recomputed the chunk list every slice, on the theory that
// the work is self-eliminating: targets come from the CURRENT summary, so a chunk
// that got tuned is no longer failing and drops out by itself. That is true of a
// chunk that got tuned. It is catastrophically untrue of every OTHER chunk —
// keeping one override changes the retrieval fingerprint for the whole corpus, so
// after slice 1 every question except the tuned chunk's own is stale,
// failingMetrics() returns [] for a stale question, and slice 2 planned an empty
// sweep and fell through to its tail reporting nothing. The streamed driver never
// showed this because it loops the whole list inside one run() call.
//
// So the chunk list is FROZEN at plan time and filtered per slice instead of
// rebuilt (lib/jobs/steps/autotuneSlice.ts holds that filter, and the regression
// test for it). Five things are not recoverable per slice:
//
//   plan                         the frozen, ordered chunk list. Ordering is
//                                prepareAutotune's worst-first sort captured
//                                once, so freezing costs nothing in quality.
//   startState / startOverrides  the dirty-set re-score is defined against the
//                                run's STARTING retrieval state; recompute it
//                                per slice and it becomes the state this slice
//                                started in, which proves nothing.
//   covered                      the chunks the run is finished with, for ANY
//                                reason — searched, gave up on, or skipped
//                                because a neighbour's override already fixed
//                                them. One set rather than three, because to the
//                                filter they are the same thing, and because
//                                chunks_searched is its size: count a skip as
//                                unvisited and a complete run reports a short
//                                sweep forever.
//   baselines                    frozen before-values. They feed the outcome
//                                rows — recompute those across a slice boundary
//                                and every row compares against a baseline that
//                                has already moved, and the run reports smaller
//                                deltas than it achieved.
//   runId                        so the history row is idempotent: work commits
//                                before the cursor does, so the slice that writes
//                                it can be re-run.
//
// Membership is frozen; VALUES are not. The TargetQuestion rows handed to
// searchChunk are rebuilt from live summary rows each slice, so candidate ranking
// is scored against the chunk's current standing rather than a stale snapshot.
//
// One more thing is not a cursor field but the reason startOverrides holds
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
import {
  drainStuck,
  nextChunks,
  passSize,
  type PlanEntry,
  type QuestionState,
} from "@/lib/jobs/steps/autotuneSlice";
import type { JobProgress, JobStep, StopSignal } from "@/lib/jobs/types";
import {
  barsReached,
  chunkTargetsNow,
  drainSnapshot,
  failingMetrics,
  prepareAutotune,
  searchChunk,
  type AutotuneEvent,
  type AutotuneMetric,
  type AutotuneStopReason,
  type PendingSnapshot,
} from "@/lib/rag/autotune";
import {
  insertAutotuneRun,
  type AutotuneOutcome,
  type HoldoutQuestionOutcome,
} from "@/lib/rag/autotuneStore";
import { type Split, splitRatesFor } from "@/lib/rag/evalRates";
import { type HoldoutMode, holdoutSplitKey } from "@/lib/rag/holdout";
import {
  scoreQuestions,
  screenAffectedQuestions,
  settleAffectedRescore,
  settleStale,
  staleQuestions,
  type ChangedChunk,
} from "@/lib/rag/eval";
import type { EvalCriteria } from "@/lib/rag/evalSettingsStore";
import {
  getQuestionToScore,
  getSummary,
  type EvalSummary,
  type QuestionDetail,
  type QuestionToScore,
} from "@/lib/rag/evalStore";
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

// The frozen "before" side of one HELD-OUT question — the complement of
// FrozenBaseline. No `metrics` and no `chunkId`: a held-out question was not
// targeted for anything and belongs to no chunk the run was working on. It is
// measured on all three metrics or none.
type FrozenHoldout = {
  hit: boolean | null;
  rank: number | null;
  rr: number | null;
  ndcg: number | null;
};

// WHAT THE RUN FREEZES ABOUT THE QUESTIONS IT MAY NOT SEE (0074).
//
// `rows` is the membership AND the identity: holdout_split_key is a hash of its
// keys, and every later comparison between two runs turns on that key. It has to
// be frozen because membership is destructive — syncHoldout deletes and redraws
// on a settings save, so by the time this run closes its books the set it was
// tested against may no longer exist anywhere else.
//
// `before` carries BOTH sides' rates, not just the holdout's. The train rate
// cannot be reconstructed from `baselines`: those cover only the questions the
// run TARGETED (the failing ones), while the train rate is over every question a
// human has not ignored. Recompute it later and it is the rate after tuning,
// which is the one number it must not be.
type HoldoutFreeze = {
  dials: { mode: HoldoutMode; size: number; seed: number } | null;
  before: Split;
  rows: Record<string, FrozenHoldout>;
};

export type AutotuneScope = Record<string, never>;

export type AutotuneCursor = {
  phase: "settle" | "search" | "rescore" | "outcomes" | "snapshots";
  runId: string;
  startState: string;
  startOverrides: Record<string, string>; // chunk id → override fingerprint at run start
  baselines: Record<string, FrozenBaseline>; // question id → frozen before-values
  // The held-out set as it stood when the plan was frozen, or null when the
  // config has no holdout. Frozen in the same place and for the same reason as
  // `baselines`: freezePlan runs AFTER settle, so these before-values are read
  // off a corpus that has been made clean. Captured in freshCursor they would be
  // stale, exactly as the plan and the baselines would be.
  holdoutFreeze: HoldoutFreeze | null;
  // Frozen, ordered worst-chunk-first — but NOT necessarily at t=0. Null means
  // `settle` has not finished yet and there is nothing honest to freeze: a plan
  // derived from a stale corpus is an empty one, which is the bug this file's
  // header describes, one level up. Non-null from the first `search` slice on.
  plan: PlanEntry[] | null;
  covered: string[]; // chunks the run is done with — searched, gave up, or skipped
  // Chunks whose search threw. A subset of `covered` — the run is done with them
  // — kept apart so the history row can say a sweep finished with holes in it
  // rather than reporting all of them as searched (§C fix 3).
  failed: string[];
  attempts: number;
  pendingChoice: number;
  stopReason: AutotuneStopReason | null;
  // How the TAIL ended, as distinct from why the search stopped: 'stuck' means
  // the re-score settled a dirty set that would not shrink. See runRescore.
  tailStatus: "stuck" | null;
  snapshots: PendingSnapshot[];
  // How many questions the previous re-score pass found dirty. The phase has no
  // cursor of its own — it re-screens and the set drains — so this is the only
  // thing standing between it and an infinite loop if a question can never come
  // back clean. See runRescore.
  lastDirty: number | null;
  // The same guard for `settle`, which drains the same way and against the same
  // hazard. Kept apart from lastDirty because the two phases run against
  // different sets and a settle that would not shrink says nothing about the
  // tail's progress later.
  lastStale: number | null;
};

// A cursor past `settle`, i.e. one whose plan is frozen. The search phase is
// written against this rather than against a nullable field, so "is the plan
// frozen by now" is answered once, at the phase boundary, instead of at every use.
type PlannedCursor = AutotuneCursor & { plan: PlanEntry[] };

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
    // An un-frozen plan still owes the bar a denominator. Chunks with a stale or
    // failing question is what the plan will be once `settle` has run, and it is
    // exactly `plan.length` when nothing is stale — so the estimate is only an
    // estimate in the case that has one.
    return { totalUnits: cursor.plan?.length ?? (await estimateChunks()), cursor };
  },

  async run(_scope, cursor, emit, shouldStop) {
    // A job created without one (the smoke harness writes ledger rows directly)
    // freezes its run-start state here instead — later than launch, but still
    // before the first chunk is touched, which is the property that matters.
    const c = cursor ?? (await freshCursor());
    if (c.phase === "settle") return runSettle(c, emit, shouldStop);
    if (c.phase === "search") return runSearch(await ensurePlanned(c), emit, shouldStop);
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
      chunksSearched: cursor.covered.length,
      chunksTotal: cursor.plan?.length ?? 0,
      stopReason: cursor.stopReason,
      recall: summary.recall,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
    };
  },
};

// The run's starting point, and the only place its un-recomputable values are
// captured. Reads only — it is also what the ETA route reaches through plan().
//
// The plan and the baselines are the two things that CANNOT be captured here when
// the corpus is stale, because both are derived from prepareAutotune's targets and
// failingMetrics() returns [] for a stale question. So a run that finds stale work
// starts in `settle` with neither, and freezes both when it gets there. Nothing
// else moves: startState and startOverrides are the run's true starting point and
// settle changes neither (it re-scores; it does not touch an override).
async function freshCursor(): Promise<AutotuneCursor> {
  const startState = await retrievalStateFingerprint();
  const stale = await staleQuestions(startState);
  const cursor: AutotuneCursor = {
    phase: stale.length > 0 ? "settle" : "search",
    runId: randomUUID(),
    startState,
    startOverrides: Object.fromEntries(await overrideFingerprints()),
    baselines: {},
    holdoutFreeze: null,
    plan: null,
    covered: [],
    failed: [],
    attempts: 0,
    pendingChoice: 0,
    stopReason: null,
    tailStatus: null,
    snapshots: [],
    lastDirty: null,
    lastStale: null,
  };
  return stale.length > 0 ? cursor : freezePlan(cursor);
}

// Freeze the ordered chunk list and the frozen baselines against the corpus AS IT
// IS NOW. Called once per run — either straight from freshCursor when nothing was
// stale, or from the end of `settle` when the corpus has been made plannable.
async function freezePlan(c: AutotuneCursor): Promise<AutotuneCursor> {
  const prepared = await prepareAutotune();
  if (!prepared.ok) return { ...c, phase: "search", plan: [] };
  const baselines: Record<string, FrozenBaseline> = { ...c.baselines };
  for (const t of prepared.targets) {
    baselines[t.questionId] = {
      chunkId: t.sourceChunkId,
      metrics: t.metrics,
      hit: t.beforeHit,
      rank: t.beforeRank,
      rr: t.beforeRr,
      ndcg: t.beforeNdcg,
    };
  }
  return {
    ...c,
    phase: "search",
    baselines,
    holdoutFreeze: freezeHoldout(prepared.summary, prepared.prep.criteria),
    plan: prepared.orderedChunks.map(([chunkId, ts]) => ({
      chunkId,
      questionIds: ts.map((t) => t.questionId),
    })),
  };
}

// The complementary snapshot: the questions this run is FORBIDDEN to see, with
// their before-values and the rates of both sides.
//
// Free, in the sense that costs anything: every value here is read off the
// getSummary() prepareAutotune has already done. No extra scoring, no extra
// model call — which is what makes recording it unconditional rather than a
// setting.
//
// Null when nothing is held out, so the run's holdout columns stay null. That
// reads the same in the database as "this run predates the recording", and it
// has to: both are cases where there is no measurement, and inventing a zero for
// either would be the assertion 0074 exists to avoid.
function freezeHoldout(summary: EvalSummary, criteria: EvalCriteria): HoldoutFreeze | null {
  const held = summary.questions.filter((q) => q.heldOut);
  if (held.length === 0) return null;
  const rows: Record<string, FrozenHoldout> = {};
  for (const q of held) {
    rows[q.questionId] = { hit: q.hit, rank: q.foundRank, rr: q.rr, ndcg: q.ndcg };
  }
  const dials = criteria.autotune.holdout;
  return {
    // Recorded for display only. Two runs with identical dials can have
    // different test sets (the draw tops up), which is why the key and not this
    // triple is what decides comparability.
    dials: { mode: dials.mode, size: dials.size, seed: dials.seed },
    before: splitRatesFor(summary.questions, new Set(Object.keys(rows))),
    rows,
  };
}

// A cursor that reached `search` without a plan. Only two things produce one: a
// cursor persisted before the plan was frozen at all (this file's older shape),
// and a settle that somehow handed over without freezing. Both are recoverable by
// doing the freeze now — the corpus has already been settled, so this reads the
// same thing freezePlan would have.
async function ensurePlanned(c: AutotuneCursor): Promise<PlannedCursor> {
  const planned = c.plan === null || c.plan === undefined ? await freezePlan(c) : c;
  return planned as PlannedCursor;
}

// The denominator for a run whose plan is not frozen yet: chunks holding at least
// one question that is stale or below its bar. Read-only, like everything plan()
// reaches.
async function estimateChunks(): Promise<number> {
  const summary = await getSummary();
  const criteria = summary.criteria as EvalCriteria;
  const chunks = new Set<string>();
  for (const q of summary.questions) {
    if (q.stale || failingMetrics(q, criteria).length > 0) chunks.add(q.sourceChunkId);
  }
  return chunks.size;
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

// --- phase 0: settle --------------------------------------------------------

// A PLAN MAY NOT BE FROZEN AGAINST A STALE CORPUS
// (docs/autotune-slicing-fixes-plan.md §D.1).
//
// This phase exists because of what a dead run now leaves behind. It used to
// leave nothing: a streamed run was one transaction, so dying rolled the whole
// thing back and the next run planned against an untouched corpus. Once slices
// commit, an abandoned run leaves committed overrides AND a corpus whose every
// other question is stale under them — and prepareAutotune excludes a stale
// question, so the next run plans a near-empty sweep and reports "nothing to
// target" over a config that plainly needs tuning. That is the same defect as the
// slice-2 bug in this file's header, one level up: derive work from a corpus
// somebody else made stale and the answer is silently empty.
//
// The background job has had this hole all along (a job that fails for good
// strands the same state); per-slice streaming only makes it reachable often. One
// implementation covers both, because `settle` is a PHASE, not driver code —
// neither driver knows what a phase is, so there is no second copy to drift.
//
// Belt and braces with the per-chunk freshening in autotuneSlice.ts, and both are
// worth keeping: this makes the PLAN and its ordering honest, while the per-chunk
// re-score makes each individual skip decision honest even for staleness this
// phase did not anticipate.
async function runSettle(c: AutotuneCursor, emit: Emit, shouldStop: () => boolean) {
  const stale = await staleQuestions(c.startState);

  // The same guard runRescore carries, against the same hazard: a question that
  // cannot come back clean would re-score forever, and on the streamed path
  // mustFinish is not yet set so there is nothing else to stop it.
  // A settle that cannot finish ENDS THE RUN, which is where this guard differs
  // from the one in runRescore. That one settles anyway and says so through
  // tail_status, because by then the money is spent and the books have to close on
  // it. Here nothing has been spent and no override has moved, so the choice is
  // between saying "this corpus cannot be scored" and planning against it — and
  // planning against it is precisely the empty sweep this phase exists to prevent.
  if (drainStuck(stale.length, c.lastStale)) {
    const message =
      `Could not re-score ${stale.length} stale question(s), so there is no ` +
      `trustworthy corpus to tune against. Re-score all questions, then try again.`;
    console.warn(`[rag:autotune] settle made no progress at ${stale.length} stale; giving up`);
    emit({ doneUnits: 0, event: { type: "error", message } });
    return { cursor: c, done: true, doneUnits: 0 };
  }

  if (stale.length === 0) {
    // Settled: drop the change log and freeze the snapshot, then freeze the plan
    // against a corpus that can now answer "is this question failing".
    await settleStale();
    return { cursor: await freezePlan(c), done: false, doneUnits: 0 };
  }

  emit({ doneUnits: 0, event: { type: "rescore-start", total: stale.length } });
  let i = 0;
  while (i < stale.length && !shouldStop()) {
    const batch = stale.slice(i, i + RESCORE_BATCH);
    const offset = i;
    await scoreQuestions(
      batch,
      (event) => {
        if (event.type === "score-result") {
          emit({
            doneUnits: 0,
            message: `Settling ${offset + event.done} of ${stale.length} stale questions`,
            event: { type: "rescore-progress", done: offset + event.done, total: stale.length },
          });
        }
      },
      NEVER_STOP,
    );
    i += batch.length;
  }

  return {
    cursor: { ...c, lastStale: passSize(i, stale.length, c.lastStale) },
    done: false,
    doneUnits: 0,
  };
}

// --- phase 1: search --------------------------------------------------------

async function runSearch(c: PlannedCursor, emit: Emit, shouldStop: StopSignal) {
  const covered = new Set(c.covered);
  const failed = new Set(c.failed);
  const prepared = await prepareAutotune();
  if (!prepared.ok) {
    emit({ doneUnits: covered.size, event: { type: "error", message: prepared.error } });
    // Before the first chunk this is just "there is nothing to target" — no
    // overrides changed, so the tail would write an empty history row against an
    // unchanged corpus. After it, the criteria were edited mid-run: the searching
    // is over but the books still have to close on what it already spent. That
    // ending used to leave stopReason null, which read as a completed sweep.
    if (covered.size === 0) return { cursor: c, done: true, doneUnits: 0 };
    return {
      cursor: { ...c, phase: "rescore" as const, stopReason: "aborted" as const },
      done: false,
      doneUnits: covered.size,
      mustFinish: true,
    };
  }
  const { prep, summary } = prepared;
  const chunksTotal = c.plan.length;

  // First slice only: the run's shape, once, with the totals it started from.
  if (covered.size === 0) {
    emit({
      doneUnits: 0,
      event: {
        type: "autotune-start",
        targeted: prepared.targets.length,
        chunks: chunksTotal,
        search: prep.search,
        apply: prep.applyMode,
      },
    });
  }

  // Live values for the frozen plan's questions, indexed once. `targets` is the
  // fresh-and-below-bar set, so presence in it IS the failing test, and it also
  // carries the current before-values searchChunk ranks candidates against.
  const targetsByQuestion = new Map(prepared.targets.map((t) => [t.questionId, t]));
  const planned = new Set(c.plan.map((e) => e.chunkId));

  // Newly seen targets get a frozen baseline too: a question can start failing
  // between slices (a neighbouring override moved it), and it is a target of this
  // run from the moment the run first sees it — but only if its chunk is in the
  // frozen plan. A chunk that starts failing mid-run is the NEXT run's work, and
  // baselining it here would land it in the outcome rows as
  // targeted-and-unresolved, diluting a rate this run never had a shot at.
  for (const t of prepared.targets) {
    if (!(t.questionId in c.baselines) && planned.has(t.sourceChunkId)) {
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

  const live = liveQuestionState(summary, targetsByQuestion);
  const todo = nextChunks(c.plan, covered, live);
  let rates = prepared.rates;
  let attempts = c.attempts;
  let pendingChoice = c.pendingChoice;
  let index = 0;

  for (const decision of todo) {
    const chunkId = decision.chunkId;
    if (prep.stopEarly && barsReached(prep, rates)) {
      emit({
        doneUnits: covered.size,
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
          cursor: {
            ...c,
            attempts,
            pendingChoice,
            covered: [...covered],
            failed: [...failed],
          },
          done: false,
          doneUnits: covered.size,
        };
      }
      if (why === "budget") {
        emit({
          doneUnits: covered.size,
          event: {
            type: "budget-stop",
            searchedChunks: covered.size,
            skippedChunks: todo.length - index,
            elapsedMs: STREAM_BUDGET_MS,
          },
        });
      }
      c.stopReason = why === "budget" ? "budget" : "cancelled";
      break;
    }
    index += 1;

    // Membership was frozen at plan time; the VALUES are read live, so candidates
    // are ranked against the chunk's current standing rather than a snapshot.
    let chunkTargets = decision.questionIds
      .map((id) => targetsByQuestion.get(id))
      .filter((t) => t !== undefined);

    // A planned chunk whose questions have gone stale: re-score just those (~1.2
    // per chunk) so the skip-or-search decision is a fact rather than a guess.
    // applyAutotuneCandidate already does this same re-score, just after the
    // search — too late to have saved the effort the search costs.
    if (decision.action === "rescore") {
      // Same shape as applyAutotuneCandidate's rescoreChunk: the lookups run
      // concurrently so assembling the batch is one round trip, then a single
      // scoreQuestions call pays the per-call fixed costs once.
      const toScore = (
        await Promise.all(decision.questionIds.map((id) => getQuestionToScore(id)))
      ).filter((q): q is QuestionToScore => q !== null);
      if (toScore.length > 0) await scoreQuestions(toScore, () => {}, NEVER_STOP);
      chunkTargets = (await chunkTargetsNow(chunkId, decision.questionIds)).targets;
    }

    // Covered either way: the run is finished with this chunk, and a chunk a
    // neighbour's override already fixed is coverage, not work left undone.
    covered.add(chunkId);
    if (chunkTargets.length === 0) continue;

    emit({
      doneUnits: covered.size - 1,
      message: `Tuning chunk ${covered.size} of ${chunksTotal}`,
      event: {
        type: "chunk-start",
        chunkId,
        fileName: chunkTargets[0].fileName,
        position: chunkTargets[0].position,
        index: covered.size,
        total: chunksTotal,
        questions: chunkTargets.length,
      },
    });

    let result;
    try {
      result = await searchChunk(prep, chunkId, chunkTargets, (event) =>
        emit({ doneUnits: covered.size - 1, event }),
      );
    } catch (err) {
      // One chunk's search failing must not end the sweep — the chunks already
      // confirmed are committed and the rest are still worth trying. Recorded as a
      // failed unit so a job that finishes with holes says so (0066), and counted
      // on the cursor so the history row can say the same for a streamed run,
      // which has no job row to carry it.
      const message = err instanceof Error ? err.message : "Chunk search failed.";
      emit({
        doneUnits: covered.size,
        failure: message,
        event: { type: "chunk-unresolved", chunkId, reason: message },
      });
      failed.add(chunkId);
      continue;
    }

    attempts += result.attempts;
    pendingChoice += result.pendingChoice;
    if (result.snapshot) c.snapshots.push(result.snapshot);
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
      attempts,
      pendingChoice,
      covered: [...covered],
      failed: [...failed],
    },
    done: false,
    doneUnits: covered.size,
    mustFinish: true,
  };
}

// Every planned question's standing right now. Staleness comes from the summary
// row (a stale question has a stored score computed under a retrieval state that
// no longer exists); failing comes from membership in the target list, which is
// already the fresh-and-below-bar set with ignores and chunk scope applied.
function liveQuestionState(
  summary: EvalSummary,
  targetsByQuestion: ReadonlyMap<string, unknown>,
): Map<string, QuestionState> {
  const live = new Map<string, QuestionState>();
  for (const q of summary.questions) {
    live.set(
      q.questionId,
      q.stale ? "stale" : targetsByQuestion.has(q.questionId) ? "failing" : "passing",
    );
  }
  return live;
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
  const stuck = drainStuck(screen.dirty.length, c.lastDirty);
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
      // Settling a set that would not shrink stamps rows clean under a state some
      // question never actually reached. The warning above says so to the log; the
      // history row has to say it too, or a run that gave up on its tail is
      // indistinguishable from one that came clean.
      cursor: { ...c, phase: "outcomes" as const, tailStatus: stuck ? ("stuck" as const) : null },
      done: false,
      doneUnits: c.covered.length,
      mustFinish: true,
    };
  }

  // No cursor of its own: a question scored under the final state drops out of the
  // next screen, so the phase eliminates its own work exactly like the search does.
  emit({ doneUnits: c.covered.length, event: { type: "rescore-start", total: screen.dirty.length } });
  let i = 0;
  while (i < screen.dirty.length && !shouldStop()) {
    const batch = screen.dirty.slice(i, i + RESCORE_BATCH);
    const offset = i;
    await scoreQuestions(
      batch,
      (event) => {
        if (event.type === "score-result") {
          emit({
            doneUnits: c.covered.length,
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

  const lastDirty = passSize(i, screen.dirty.length, c.lastDirty);
  return { cursor: { ...c, lastDirty }, done: false, doneUnits: c.covered.length, mustFinish: true };
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

  // The held-out side, read off the SAME closing summary as everything above.
  //
  // THIS IS ONLY SOUND BECAUSE HELD-OUT QUESTIONS ARE STILL SCORED.
  // latestResultsForScreening and questionsNeedingScoring (evalStore.ts) select
  // every labeled question under the config with no ignore filter — the holdout
  // is excluded from RATES and from TARGETING, never from SCORING. So these
  // after-values are genuine post-run retrieval and not the before-values coming
  // back around. If that ever changes, this feature reports zero deltas rather
  // than failing, which is the worst way for it to break: whoever touches those
  // queries needs to know this reads them.
  const holdout = c.holdoutFreeze === null ? null : holdoutCapture(c.holdoutFreeze, summary, afterByQ);
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
      chunksTotal: c.plan?.length ?? 0,
      chunksSearched: c.covered.length,
      chunksFailed: c.failed.length,
      tailStatus: c.tailStatus,
      holdout,
    },
    outcomes,
  );
  console.log(
    `[rag:autotune] books closed: targeted=${targeted} resolved=${resolved} improved=${improved} ` +
      `chunks=${c.covered.length}/${c.plan?.length ?? 0} stop=${c.stopReason ?? "complete"} ` +
      `attempts=${c.attempts} pendingChoice=${c.pendingChoice}`,
  );
  emit({ doneUnits: c.covered.length, message: "Recording results" });
  return {
    cursor: { ...c, phase: "snapshots" as const },
    done: false,
    doneUnits: c.covered.length,
    mustFinish: true,
  };
}

// Close the books on the held-out set: the frozen before-values, the after-values
// off the closing summary, and both sides' rates at both ends.
//
// Membership comes from the FREEZE, never from the summary's live `heldOut`
// flags — the draw can be redrawn from Settings while a run is in flight, and a
// before over one test set minus an after over another is not a delta. See
// splitRatesFor.
function holdoutCapture(
  freeze: HoldoutFreeze,
  summary: Pick<EvalSummary, "questions">,
  afterByQ: Map<string, QuestionDetail>,
): NonNullable<Parameters<typeof insertAutotuneRun>[1]["holdout"]> {
  const members = new Set(Object.keys(freeze.rows));
  const rows: HoldoutQuestionOutcome[] = Object.entries(freeze.rows).map(([questionId, b]) => {
    // A question that has vanished from the summary (deleted mid-run, or its
    // label moved off this config) keeps its before-values and gets null afters.
    // Dropping the row instead would change the split key the aggregates were
    // computed under, and quietly make this run incomparable to its siblings.
    const a = afterByQ.get(questionId) ?? null;
    return {
      questionId,
      beforeHit: b.hit,
      beforeRank: b.rank,
      beforeRr: b.rr,
      beforeNdcg: b.ndcg,
      afterHit: a?.hit ?? null,
      afterRank: a?.foundRank ?? null,
      afterRr: a?.rr ?? null,
      afterNdcg: a?.ndcg ?? null,
    };
  });
  return {
    dials: freeze.dials,
    splitKey: holdoutSplitKey([...members]),
    before: freeze.before,
    after: splitRatesFor(summary.questions, members),
    rows,
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
    emit({ doneUnits: c.covered.length, message: `Saving trials (${left.length} left)` });
  }
  return {
    cursor: { ...c, snapshots: left },
    done: left.length === 0,
    doneUnits: c.covered.length,
    mustFinish: true,
  };
}
