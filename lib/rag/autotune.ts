// ---------------------------------------------------------------------------
// AUTOTUNE ENGINE (Phase C of docs/eval-autotuning-plan.md).
//
// For every question below its min-rate (D1), search per chunk for a re-shape
// that lifts it: chunk SIZE first (Stage 1), then alternate MODELS — both the
// full chunk and the best sub-size under each model (Stage 2), then remaining
// size × model combos (Stage 3) — per the A2/A4 ladder. A winning candidate is
// persisted as a per-chunk override (pieces, Phase B), CONFIRMED through real
// rank-fused retrieval (reverted if the approximation over-promised — the
// runner-up finalists then get their turn before the chunk is given up on),
// snapshotted into the chunk's "Models tried" list (eval_model_trials — the
// kept winner only, not every search rung; L10: deferred to after the run
// reports done, since nothing in the run reads it back), and the run ends
// with a dirty-set re-score (A3 — only questions the kept overrides could have
// affected re-run retrieval; the rest are proven unchanged and re-stamped, see
// eval.rescoreAffectedQuestions) + an eval_runs snapshot (feeds Appraise)
// + an autotune_runs history row.
//
// autotune.keepBest (0026): when NO candidate clears a chunk's bar (or every
// finalist fails its confirm), the best strictly-improving candidate is kept
// instead under a relaxed-but-real confirm — no new failures allowed and the
// failing pairs' metric values must actually rise on real retrieval. Reported
// as "improved", never as resolved.
//
// The inner search ranks every candidate through the REAL rank-fused dry-run
// (fuseWithOverrides with the hypothetical override injected — the same
// methodology as runModelTrial's fusedRank), so a candidate's rank IS the
// merged position live retrieval would give it. The remaining approximation:
// per-question nDCG can't be recomputed cheaply mid-search, so an nDCG-failing
// question "clears" approximately when its ground-truth rank lands within
// ndcg_k without regressing. The per-chunk confirm re-score (real retrieval,
// real metrics) is the arbiter either way — it also catches override state
// drifting between a chunk's search and its apply.
// ---------------------------------------------------------------------------
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import type { StreamErrorEvent } from "@/lib/http/missingKey";
import { autotuneModelLadder } from "@/lib/config";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  insertAutotuneRun,
  listIgnoredQuestionIds,
  type AutotuneOutcome,
} from "@/lib/rag/autotuneStore";
import { splitText } from "@/lib/rag/chunker";
import { embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
import { modelSpec } from "@/lib/rag/embeddingModels";
import { availableProviders } from "@/lib/rag/providerAvailability";
import {
  rescoreAffectedQuestions,
  runModelTrial,
  scoreQuestions,
  setChunkModelOverride,
  setChunkSizeModelOverride,
  setChunkSizeOverride,
  type ChangedChunk,
  type TrialVariation,
} from "@/lib/rag/eval";
import { effectiveK, type EvalCriteria } from "@/lib/rag/evalSettingsStore";
import {
  getChunkQuestions,
  getQuestionToScore,
  type QuestionToScore,
  getChunksByIds,
  getModelTrialQuestions,
  getSummary,
  type QuestionDetail,
} from "@/lib/rag/evalStore";
import {
  clearChunkOverride,
  getChunkOverridePieces,
  listOverrides,
  overrideEmbeddings,
  retrievalStateFingerprint,
  setChunkOverridePieces,
  type ChunkOverride,
  type OverrideEmbedding,
} from "@/lib/rag/overrideStore";
import { fuseWithOverrides } from "@/lib/rag/retriever";
import type { RetrievedChunk } from "@/types/rag";

export type AutotuneMetric = "recall" | "mrr" | "ndcg";
export type CandidateFamily = "size" | "model" | "size+model";

// Tie-break when candidate scores are EQUAL (common — score is Σ 1/rank, so
// same ranks give identical floats): prefer the cheaper override family.
// size stays in the base embedding space; model adds another space to fusion
// (an extra query embedding per live retrieval); combo is both.
const familyRank: Record<CandidateFamily, number> = { size: 0, model: 1, "size+model": 2 };

// One override candidate found by the search, with its approximate standing.
export type AutotuneCandidate = {
  family: CandidateFamily;
  size: number | null; // null for model-only (full chunk)
  overlap: number | null;
  model: string | null; // null = the config's base model (size-only)
  clears: boolean; // every targeted (question, metric) cleared — approximately
  score: number; // Σ 1/rank over the chunk's targeted questions (higher = better)
  ranks: { questionId: string; rank: number | null }[];
};

export type AutotuneEvent =
  | {
      type: "autotune-start";
      targeted: number; // below-bar questions
      chunks: number;
      search: string;
      apply: string;
    }
  | {
      type: "chunk-start";
      chunkId: string;
      fileName: string;
      position: number | null;
      index: number; // 1-based, over `total` chunks
      total: number;
      questions: number; // targeted questions on this chunk
    }
  | {
      type: "attempt";
      chunkId: string;
      stage: "size" | "model" | "combo";
      detail: string;
      attempts: number; // running total across the run (cost proxy)
    }
  | { type: "chunk-resolved"; chunkId: string; candidate: AutotuneCandidate }
  | {
      // autotune.keepBest: no candidate cleared the bar, so the best
      // strictly-improving one was kept instead — the chunk's questions are
      // still below their min-rate, just closer.
      type: "chunk-improved";
      chunkId: string;
      candidate: AutotuneCandidate;
    }
  | {
      // apply='choose' and more than one FAMILY cleared: nothing applied; the
      // user picks via POST /api/eval/autotune/apply after the run.
      type: "chunk-choice";
      chunkId: string;
      fileName: string;
      position: number | null;
      candidates: AutotuneCandidate[];
    }
  | { type: "chunk-unresolved"; chunkId: string; reason: string }
  | {
      // autotune.stopEarly: every targeted metric's aggregate rate reached its
      // min-rate mid-run, so the remaining below-bar chunks were skipped.
      type: "early-stop";
      skippedChunks: number;
      recall: number | null;
      mrr: number | null;
      ndcg: number | null;
    }
  // The run's id, first line of every NDJSON stream (emitted by ndjsonStream
  // itself, not by the engine) — what POST /api/eval/cancel needs to reach it.
  | { type: "run-started"; runId: string }
  | { type: "rescore-start"; total: number }
  | { type: "rescore-progress"; done: number; total: number }
  | {
      type: "autotune-done";
      // Cancel was pressed: the chunk search stopped early, exactly like
      // early-stop does. Everything applied before that point is kept, and the
      // run still re-scores, snapshots, and reports below.
      cancelled?: boolean;
      targeted: number;
      resolved: number;
      unresolved: number;
      improved: number; // subset of unresolved: still below bar, but better
      pendingChoice: number;
      attempts: number;
      recall: number | null;
      mrr: number | null;
      ndcg: number | null;
      durationMs: number;
    }
  // The shared stream error shape — carries the missing-provider-key fields
  // when that was the cause, so every stream reports it the same way the
  // plain routes do. See lib/http/missingKey.ts.
  | StreamErrorEvent;

type Emit = (event: AutotuneEvent) => void;

// A below-bar question: which enabled-with-min-rate metrics it fails, plus its
// current standing (the "before" side of the outcome rows).
type TargetQuestion = {
  questionId: string;
  question: string;
  sourceChunkId: string;
  fileName: string;
  position: number | null;
  metrics: AutotuneMetric[];
  beforeHit: boolean;
  beforeRank: number | null;
  beforeRr: number | null;
  beforeNdcg: number | null;
};

// Which targeted metrics a FRESHLY SCORED question fails under the criteria
// (D1: recall per-question is binary, so any positive recall min-rate means
// "must be a hit"; MRR compares the per-question reciprocal rank at mrr_k;
// nDCG is graded against its own min-rate). Unscored, stale, and ungraded-nDCG
// questions are not targetable.
function failingMetrics(q: QuestionDetail, criteria: EvalCriteria): AutotuneMetric[] {
  if (q.ignored || q.hit === null || q.stale) return [];
  const out: AutotuneMetric[] = [];
  const r = criteria.recall;
  if (r.enabled && r.minRate !== null && r.minRate > 0 && q.hit === false) {
    out.push("recall");
  }
  const m = criteria.mrr;
  if (m.enabled && m.minRate !== null && m.minRate > 0 && q.rr !== null && q.rr < m.minRate) {
    out.push("mrr");
  }
  const n = criteria.ndcg;
  if (n.enabled && n.minRate !== null && q.ndcg !== null && q.ndcg < n.minRate) {
    out.push("ndcg");
  }
  return out;
}

// The set of failing (questionId, metric) pairs for a chunk's questions — the
// regression check compares this before vs after an applied override.
function failingPairs(questions: QuestionDetail[], criteria: EvalCriteria): Set<string> {
  const pairs = new Set<string>();
  for (const q of questions) {
    for (const m of failingMetrics(q, criteria)) pairs.add(`${q.questionId}:${m}`);
  }
  return pairs;
}

// The effective per-metric depths (and MRR's min-rate) one run targets — the
// bar approxClears checks candidates against.
type MetricBars = { recallK: number; mrrK: number; mrrMinRate: number; ndcgK: number };

// Approximate bar-clearing for one question at a candidate's ground-truth rank.
// recall: within recall_k. MRR: 1/rank at mrr_k must reach the min-rate (exact
// — rr is fully determined by the rank). nDCG: within ndcg_k without losing
// rank — the real graded value is only computed at confirm time (see header).
function approxClears(t: TargetQuestion, rank: number | null, bars: MetricBars): boolean {
  if (rank === null) return false;
  for (const m of t.metrics) {
    if (m === "recall" && rank > bars.recallK) return false;
    if (m === "mrr" && (rank > bars.mrrK || 1 / rank < bars.mrrMinRate)) return false;
    if (m === "ndcg" && (rank > bars.ndcgK || (t.beforeRank !== null && rank > t.beforeRank))) {
      return false;
    }
  }
  return true;
}

function mkCandidate(
  family: CandidateFamily,
  size: number | null,
  overlap: number | null,
  model: string | null,
  targets: TargetQuestion[],
  ranks: (number | null)[],
  bars: MetricBars,
): AutotuneCandidate {
  return {
    family,
    size,
    overlap,
    model,
    clears: targets.every((t, i) => approxClears(t, ranks[i], bars)),
    score: ranks.reduce<number>((s, r) => s + (r === null ? 0 : 1 / r), 0),
    ranks: targets.map((t, i) => ({ questionId: t.questionId, rank: ranks[i] })),
  };
}

// The model ladder actually usable right now: cheapest-first (A4), minus the
// config's base model and any provider without a key/weights. `scope` (the
// config's autotune.modelScope, 0030) further whitelists model ids: null = no
// restriction; an explicit list keeps only its members (so [] = size-only).
async function usableModelLadder(scope: string[] | null): Promise<string[]> {
  const base = activeConfig().embeddingModel;
  const allowed = scope === null ? null : new Set(scope);
  const availability = await availableProviders();
  return autotuneModelLadder.filter((id) => {
    if (id === base) return false;
    if (allowed !== null && !allowed.has(id)) return false;
    try {
      return availability.has(modelSpec(id).provider);
    } catch {
      return false;
    }
  });
}

// Candidate trial: the REAL rank-fused dry-run — inject the candidate as a
// hypothetical override (replacing any stored override on this chunk), run
// fuseWithOverrides per target question, and read the chunk's merged position.
// Same methodology as runModelTrial's fusedRank, so a candidate's rank here is
// the rank live retrieval (and the confirm re-score) would actually produce.
// `candidateTexts` are the re-split pieces, or [whole chunk] for model-only;
// `model` is the space they compete in (the base model for size-only). `pool`
// is autotune's fusion pool (0027) — null follows live retrieval's. The
// confirm re-score always runs at the live pool, so a smaller search pool
// only trades embedding cost for coarser ranks (and possible confirm reverts).
// L15: everything a chunk's search re-reads identically on every rung. The
// search phase was 257.8s (55% of the run) and untouched — because the doc's
// search levers (L1 fan-out, L3 pre-warm) both assumed the cost was EMBEDDING
// round-trips, so nobody looked at the DB reads repeating underneath.
//
// Per rung, fusedTrialRanks was re-fetching `listOverrides()`, re-pulling every
// stored override vector (its piece cache lived one call), and re-running an
// identical base ANN per target. None of it varies across the ~6 rungs a chunk
// tries: overrides are only ever persisted in CONFIRM, never mid-search.
//
// Lifetime is exactly one chunk's search, so it's built in the chunk loop and
// thrown away after — no fingerprint key needed, because nothing can invalidate
// it while it lives.
type SearchContext = {
  storedOverrides: ChunkOverride[];
  storedPieces: Map<string, Promise<OverrideEmbedding[]>>;
  annCache: Map<string, RetrievedChunk[]>;
};

async function buildSearchContext(chunkId: string): Promise<SearchContext> {
  return {
    // This chunk's own override never competes — the candidate replaces it.
    storedOverrides: (await listOverrides()).filter((o) => o.sourceChunkId !== chunkId),
    storedPieces: new Map(),
    annCache: new Map(),
  };
}

async function fusedTrialRanks(
  targets: TargetQuestion[],
  chunkId: string,
  candidateTexts: string[],
  family: CandidateFamily,
  model: string,
  pool: number | null,
  search: SearchContext,
): Promise<(number | null)[]> {
  const candVecs = await embedDocsCached(candidateTexts, model);
  const hypOverrides: ChunkOverride[] = [
    ...search.storedOverrides,
    { sourceChunkId: chunkId, model, kind: family },
  ];
  // Pieces per model: the stored overrides minus this chunk's (fetched once per
  // chunk, not once per rung), plus the in-memory candidate vectors under the
  // trial model. The candidate part DOES change per rung, so only the stored
  // half is shared.
  const piecesFor = (m: string): Promise<OverrideEmbedding[]> => {
    let stored = search.storedPieces.get(m);
    if (!stored) {
      stored = overrideEmbeddings(m).then((all) =>
        all.filter((piece) => piece.chunkId !== chunkId),
      );
      search.storedPieces.set(m, stored);
    }
    return stored.then((kept) =>
      m === model ? [...kept, ...candVecs.map((embedding) => ({ chunkId, embedding }))] : kept,
    );
  };

  const cfg = activeConfig();
  const ranks: (number | null)[] = [];
  for (const t of targets) {
    const baseQVec = await embedQueryCached(t.question, cfg.embeddingModel);
    const { merged } = await fuseWithOverrides(
        t.question,
        baseQVec,
        cfg.topK,
        hypOverrides,
        piecesFor,
        pool,
      search.annCache,
    );
    const idx = merged.findIndex((c) => c.id === chunkId);
    ranks.push(idx === -1 ? null : idx + 1);
  }
  return ranks;
}

// Persist one candidate as the chunk's override (dispatch on family).
async function persistCandidate(
  chunkId: string,
  c: Pick<AutotuneCandidate, "family" | "size" | "overlap" | "model">,
): Promise<string> {
  if (c.family === "size") {
    return setChunkSizeOverride(chunkId, c.size!, c.overlap ?? 0);
  }
  if (c.family === "model") {
    return setChunkModelOverride(chunkId, c.model!);
  }
  return setChunkSizeModelOverride(chunkId, c.size!, c.overlap ?? 0, c.model!);
}

// Snapshot a KEPT candidate into the chunk's saved trials (eval_model_trials),
// so it shows up under "Models tried" like a hand-saved experiment. Only the
// winner is saved — every search rung would drown the list. The pool mirrors
// the manual runner's auto pool (getModelTrialContext): the distractors the
// chunk's questions already retrieved; runModelTrial re-adds the chunk itself.
// Best-effort — a snapshot failure never fails (or reverts) the applied
// override, which stands on its own confirm.
//
// L10 (docs/autotune-speedups-plan.md): this is the single most expensive thing
// in a run that the run does not need — 97.6s, 41% of confirm, measured
// 2026-08-03, because each call is a FULL runModelTrial (re-chunk, embed under
// the candidate model, fused-rank the pool) and 36 candidates are kept. Nothing
// inside runAutotune reads eval_model_trials back; only the three UI-facing
// routes do. So a run defers these to after it reports done (see
// pendingSnapshots) — same rows, same UI, off the clock.
async function saveKeptTrialSnapshot(
  chunkId: string,
  c: Pick<AutotuneCandidate, "family" | "size" | "overlap" | "model">,
): Promise<void> {
  try {
    const variation: TrialVariation =
      c.family === "size"
        ? { kind: "size", size: c.size!, overlap: c.overlap ?? 0 }
        : c.family === "model"
          ? { kind: "model", model: c.model! }
          : { kind: "size+model", model: c.model!, size: c.size!, overlap: c.overlap ?? 0 };
    const questions = await getModelTrialQuestions(chunkId);
    const poolIds = [...new Set(questions.flatMap((q) => q.retrievedIds))].filter(
      (id) => id !== chunkId,
    );
    await runModelTrial(chunkId, variation, poolIds, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[rag:autotune] trial snapshot failed for chunk ${chunkId}: ${message}`);
  }
}

export type ApplyResult = {
  // 'skipped' = nothing failing on this chunk under the CURRENT override
  // state, so no candidate could help — callers should stop retrying.
  status: "kept" | "reverted" | "skipped" | "failed";
  detail: string;
  // On 'kept': how many (question, metric) checks are still failing — 0 means
  // the chunk actually cleared its bar.
  remaining?: number;
};

// The value the bar grades a (question, metric) pair on — what improve mode's
// progress check sums before vs after.
function pairValue(q: QuestionDetail, metric: AutotuneMetric): number {
  if (metric === "recall") return q.hit ? 1 : 0;
  if (metric === "mrr") return q.rr ?? 0;
  return q.ndcg ?? 0;
}

// Promote → persist → CONFIRM (§5.3): apply the override, re-score the chunk's
// own questions through real rank-fused retrieval, and keep it only if the chunk's
// failing (question, metric) set shrank with no new failures — otherwise revert
// (restoring the chunk's pre-confirm override exactly, or baseline if it had
// none) and re-score again so the stored results stay truthful. Exported
// for the post-run choice endpoint (POST /api/eval/autotune/apply).
//
// mode 'improve' (autotune.keepBest) relaxes the keep condition: the failing
// set need not shrink as long as no new (question, metric) starts failing AND
// the failing pairs' summed metric values strictly rose — still a real-
// retrieval check, so the approximation can't over-promise its way in. The
// values only move within the retrieval depth (a rank past it is a miss), so
// "improvement" can't be noise from deep-rank shuffling.
export async function applyAutotuneCandidate(
  chunkId: string,
  candidate: Pick<AutotuneCandidate, "family" | "size" | "overlap" | "model">,
  mode: "clear" | "improve" = "clear",
  // L10: the kept-trial snapshot is 100.7s (12.0%) of a run, spent inline to
  // populate a UI list. Defaults ON so the post-run apply endpoint and ordinary
  // dashboard runs are unchanged; a trial run turns it off — see the call site.
  opts: { snapshot?: boolean } = {},
): Promise<ApplyResult> {
  // L6 (docs/autotune-speedups-plan.md): chunk-scoped read, not the whole-config
  // getSummary(). This function only ever looked at THIS chunk's questions, but
  // getSummary is ~1.1s against a 162-question corpus and the confirm step ran it
  // 2-3 times per candidate — ~167s of an 894s run spent computing 160 questions
  // to read one or two. Same mapper underneath, so the values are identical.
  let before = await getChunkQuestions(chunkId);
  const criteria = before.criteria;
  let chunkQs = before.questions;
  if (chunkQs.length === 0) {
    return { status: "failed", detail: "Chunk has no questions under this config." };
  }

  // L2, revisited. The original verdict was "dead": its ceiling is
  // questions-per-chunk (1.2 here), so the 4-wide scoring pool has almost
  // nothing to parallelize. That reasoning still holds for the POOL — but it
  // only ever considered parallelism. Batching also pays the per-call fixed
  // costs (setup, and one retrieval context) ONCE per re-score instead of once
  // per question, which is a different saving the original analysis missed.
  //
  // The lookups run concurrently so the batch still costs one round trip to
  // assemble, then a single scoreQuestions call does the work.
  const rescoreChunk = async () => {
    const toScore = (
      await Promise.all(chunkQs.map((q) => getQuestionToScore(q.questionId)))
    ).filter((q): q is QuestionToScore => q !== null);
    if (toScore.length > 0) await scoreQuestions(toScore);
  };

  // Fresh baseline first: an override kept on ANOTHER chunk earlier in the run
  // changes the global retrieval fingerprint, flipping this chunk's questions
  // to stale — and failingMetrics treats stale as not-failing, which would make
  // beforeFailing empty and doom the keep condition below (afterFailing can
  // never be smaller). Re-score so before vs after is fresh-vs-fresh under the
  // same retrieval state.
  if (chunkQs.some((q) => q.stale)) {
    await rescoreChunk();
    before = await getChunkQuestions(chunkId);
    chunkQs = before.questions;
  }
  const beforeFailing = failingPairs(chunkQs, criteria);
  const failingSum = (qs: QuestionDetail[]) => {
    const byId = new Map(qs.map((q) => [q.questionId, q]));
    let sum = 0;
    for (const pair of beforeFailing) {
      const [questionId, metric] = pair.split(":") as [string, AutotuneMetric];
      const q = byId.get(questionId);
      if (q) sum += pairValue(q, metric);
    }
    return sum;
  };
  if (beforeFailing.size === 0) {
    // Nothing failing under the CURRENT retrieval state (e.g. an override kept
    // earlier in the run already lifted this chunk's questions) — an override
    // here could only regress, so skip it.
    return { status: "skipped", detail: "Chunk already passes under the current overrides." };
  }

  const beforeSum = failingSum(chunkQs);

  // Capture the chunk's CURRENT override (if any) before overwriting it —
  // persistCandidate replaces it, so a failed confirm must put THIS back, not
  // clear to baseline (which would destroy a working override kept by an
  // earlier run just because a new candidate over-promised).
  const prior = await getChunkOverridePieces(chunkId);

  const persisted = await persistCandidate(chunkId, candidate);
  if (persisted !== "ok") {
    return { status: "failed", detail: `Could not persist override (${persisted}).` };
  }

  await rescoreChunk();

  const after = await getChunkQuestions(chunkId);
  const afterQs = after.questions;
  const afterFailing = failingPairs(afterQs, criteria);
  const newFailure = [...afterFailing].some((p) => !beforeFailing.has(p));
  const progressed =
    afterFailing.size < beforeFailing.size ||
    (mode === "improve" && failingSum(afterQs) > beforeSum + 1e-9);

  if (newFailure || !progressed) {
    if (prior !== null) {
      await setChunkOverridePieces(
        chunkId,
        prior.model,
        prior.kind,
        prior.pieces,
        "restored pre-confirm override (autotune candidate reverted)",
      );
    } else {
      await clearChunkOverride(chunkId);
    }
    // Re-scored unconditionally. L7 (docs/autotune-speedups-plan.md) tried to
    // skip this by leaning on 0022's revert-awareness — restoring the prior
    // override restores the prior fingerprint, so the pre-confirm rows would
    // resurface on their own. It worked, and it was a NET LOSS: measured
    // 2026-08-02, reverts are only 3% of confirms (1 of 33), so it saved one
    // re-score per run while costing an extra fingerprint query on all 33.
    // Removed. Don't re-propose without checking the revert counter first.
    await rescoreChunk();
    return {
      status: "reverted",
      detail: newFailure
        ? "Override regressed a previously-passing question on real retrieval."
        : "Override made no real-retrieval progress (approximation over-promised).",
    };
  }
  if (opts.snapshot !== false) {
    await saveKeptTrialSnapshot(chunkId, candidate);
  }
  return {
    status: "kept",
    detail:
      afterFailing.size < beforeFailing.size
        ? `Failing checks ${beforeFailing.size} → ${afterFailing.size}.`
        : `Still ${afterFailing.size} failing check(s), but their metric values rose.`,
    remaining: afterFailing.size,
  };
}

// The run itself — driven by the streamed POST /api/eval/autotune route.
// `shouldStop` is polled between chunks, the same seam early-stop already
// breaks at: a cancelled run keeps every override it confirmed and still
// finishes its re-score and outcome accounting. It is a flag, never an
// exception — see lib/http/cancelRegistry.ts.
export async function runAutotune(
  emit: Emit = () => {},
  shouldStop: ShouldStop = NEVER_STOP,
): Promise<void> {
  const t0 = performance.now();
  // Per-phase wall-clock accounting on top of the total (durationMs): where the
  // run's time actually goes, so an optimization can be aimed before it's built.
  //   search  — the fusedTrialRanks dry-runs (Stages 1-3), incl. their embeds.
  //   confirm — applyAutotuneCandidate: persist + real-retrieval re-score/revert
  //             (+ the kept-trial snapshot). The confirm's own rescore lives here.
  //   rescore — the run-end dirty-set ripple re-score (rescoreAffectedQuestions).
  // These are diagnostic and need not sum to durationMs (getSummary/splitText/etc.
  // are the unaccounted remainder).
  const phase = { search: 0, confirm: 0, rescore: 0 };
  const timed = async <T>(bucket: keyof typeof phase, fn: () => Promise<T>): Promise<T> => {
    const s = performance.now();
    try {
      return await fn();
    } finally {
      phase[bucket] += performance.now() - s;
    }
  };
  const cfg = activeConfig();
  // Run-start override state, for the final dirty-set re-score: only chunks
  // whose override changed between here and the end can affect other
  // questions' stored results (rescoreAffectedQuestions).
  const startState = await retrievalStateFingerprint();
  const startOverrides = new Set((await listOverrides()).map((o) => o.sourceChunkId));
  const summary = await getSummary();
  const criteria = summary.criteria;

  const recallTargeting =
    criteria.recall.enabled && criteria.recall.minRate !== null;
  const mrrTargeting = criteria.mrr.enabled && criteria.mrr.minRate !== null;
  const ndcgTargeting = criteria.ndcg.enabled && criteria.ndcg.minRate !== null;
  if (!recallTargeting && !mrrTargeting && !ndcgTargeting) {
    emit({
      type: "error",
      message: "Set a min-rate on an enabled metric in Settings before autotuning.",
    });
    return;
  }

  const recallK = effectiveK(criteria.recall, cfg.topK);
  const mrrK = effectiveK(criteria.mrr, cfg.topK);
  const ndcgK = effectiveK(criteria.ndcg, cfg.topK);
  const bars: MetricBars = {
    recallK,
    mrrK,
    mrrMinRate: criteria.mrr.minRate ?? 0,
    ndcgK,
  };
  const ignored = await listIgnoredQuestionIds();
  // Chunk scope (0025): a non-null list restricts the run to those chunks;
  // null means every chunk, including ones labeled after the setting was saved.
  const scope =
    criteria.autotune.chunkScope === null ? null : new Set(criteria.autotune.chunkScope);

  // Targets: every fresh below-bar question, minus ignores, within the chunk
  // scope, grouped by chunk.
  const targets: TargetQuestion[] = [];
  for (const q of summary.questions) {
    if (ignored.has(q.questionId)) continue;
    if (scope !== null && !scope.has(q.sourceChunkId)) continue;
    const metrics = failingMetrics(q, criteria);
    if (metrics.length === 0) continue;
    targets.push({
      questionId: q.questionId,
      question: q.question,
      sourceChunkId: q.sourceChunkId,
      fileName: q.fileName,
      position: q.expectedPosition,
      metrics,
      beforeHit: q.hit === true,
      beforeRank: q.foundRank,
      beforeRr: q.rr,
      beforeNdcg: q.ndcg,
    });
  }

  const byChunk = new Map<string, TargetQuestion[]>();
  for (const t of targets) {
    const list = byChunk.get(t.sourceChunkId) ?? [];
    list.push(t);
    byChunk.set(t.sourceChunkId, list);
  }

  // Worst chunks first: lowest mean baseline reciprocal rank (a complete miss
  // counts 0), tie-broken toward more targeted questions. Those chunks drag
  // the aggregate rates hardest, so the biggest lifts land earliest — which is
  // what makes stopEarly's cutoff cheap instead of arbitrary.
  const meanRr = (ts: TargetQuestion[]) =>
    ts.reduce((s, t) => s + (t.beforeRank === null ? 0 : 1 / t.beforeRank), 0) / ts.length;
  const orderedChunks = [...byChunk.entries()].sort(
    (a, b) => meanRr(a[1]) - meanRr(b[1]) || b[1].length - a[1].length,
  );

  const search = criteria.autotune.search;
  const applyMode = criteria.autotune.apply;
  const keepBest = criteria.autotune.keepBest;
  emit({
    type: "autotune-start",
    targeted: targets.length,
    chunks: byChunk.size,
    search,
    apply: applyMode,
  });
  if (targets.length === 0) {
    emit({
      type: "autotune-done",
      targeted: 0,
      resolved: 0,
      unresolved: 0,
      improved: 0,
      pendingChoice: 0,
      attempts: 0,
      recall: summary.recall,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
      durationMs: Math.round(performance.now() - t0),
    });
    return;
  }

  const sizes = criteria.autotune.sizeLadder;
  const trialPool = criteria.autotune.fusionPool;
  const overlapFor = (size: number) =>
    Math.min(size - 1, Math.max(0, Math.round(size * criteria.autotune.overlapPct)));
  const models = await usableModelLadder(criteria.autotune.modelScope);
  // Per-chunk cap on search RUNGS (a rung = one size, or one model's two
  // branches) so even exhaustive mode is bounded (A4/A5).
  const rungCap = sizes.length + 2 * models.length + 6;

  let attempts = 0;
  let pendingChoice = 0;
  // L8 diagnostics: confirm cycles run, how many ended in a revert (the search
  // over-promising), and how many of those skipped the re-score via L7.
  let confirms = 0;
  let reverts = 0;

  // L10: kept candidates awaiting their "Models tried" snapshot. Deferred out of
  // the chunk loop because each one re-runs a FULL model trial (re-chunk,
  // re-embed, re-rank the pool) — 97.6s across a run, 41% of confirm — purely to
  // populate a UI list. Nothing inside the run reads eval_model_trials back;
  // only /api/eval/trials, /api/eval/chunks/[chunkId]/trials and try-model do.
  // Drained after the done event, so the run's RESULT no longer waits on
  // bookkeeping. Note this is a latency win, not a work win: the snapshots still
  // cost the same, they just stop sitting between chunks.
  const pendingSnapshots: { chunkId: string; candidate: AutotuneCandidate }[] = [];

  // Applied override per chunk, for the outcome rows.
  const applied = new Map<
    string,
    { kind: CandidateFamily; model: string | null; size: number | null }
  >();

  // stopEarly (0024): are all targeted metrics' AGGREGATE rates at their
  // min-rate? Checked against the latest summary after each kept override.
  // Mid-run summaries can carry stale neighbours (only the applied chunk's
  // questions are re-scored), so this is approximate — the final re-score
  // below remains the arbiter of the stored rates.
  const barsReached = (s: {
    recall: number | null;
    mrr: number | null;
    ndcg: number | null;
  }): boolean =>
    (!recallTargeting || (s.recall !== null && s.recall >= criteria.recall.minRate!)) &&
    (!mrrTargeting || (s.mrr !== null && s.mrr >= criteria.mrr.minRate!)) &&
    (!ndcgTargeting || (s.ndcg !== null && s.ndcg >= criteria.ndcg.minRate!));
  const stopEarly = criteria.autotune.stopEarly;
  let latestRates = { recall: summary.recall, mrr: summary.mrr, ndcg: summary.ndcg };
  let barsMet = stopEarly && barsReached(latestRates);

  let chunkIndex = 0;
  for (const [chunkId, chunkTargets] of orderedChunks) {
    // Checkpoint: between chunks, i.e. between searches. Break, don't throw —
    // the run's transaction commits, so the overrides confirmed so far stay.
    if (shouldStop()) break;
    if (barsMet) {
      emit({ type: "early-stop", skippedChunks: orderedChunks.length - chunkIndex, ...latestRates });
      break;
    }
    chunkIndex += 1;
    emit({
      type: "chunk-start",
      chunkId,
      fileName: chunkTargets[0].fileName,
      position: chunkTargets[0].position,
      index: chunkIndex,
      total: byChunk.size,
      questions: chunkTargets.length,
    });

    // L15: one read of the override state + one base ANN per question, shared by
    // every rung this chunk tries. Rebuilt per chunk because the previous
    // chunk's confirm may have persisted an override; within THIS chunk's
    // search nothing can change it.
    const searchCtx = await buildSearchContext(chunkId);

    const baselineScore = chunkTargets.reduce(
      (s, t) => s + (t.beforeRank === null ? 0 : 1 / t.beforeRank),
      0,
    );
    const candidates: AutotuneCandidate[] = [];
    let bestSize: AutotuneCandidate | null = null; // best IMPROVING stage-1 size
    // Best candidate seen at ANY stage that beats the baseline, clearing or
    // not — the keepBest fallback when nothing survives the bar.
    let bestEffort: AutotuneCandidate | null = null;
    const consider = (cand: AutotuneCandidate): AutotuneCandidate => {
      const cur = bestEffort;
      if (
        cand.score > baselineScore &&
        (cur === null ||
          cand.score > cur.score ||
          (cand.score === cur.score && familyRank[cand.family] < familyRank[cur.family]))
      ) {
        bestEffort = cand;
      }
      return cand;
    };
    let rungs = 0;
    let resolvedHere = false;
    let skippedHere = false; // apply said the chunk already passes — stop trying
    let lastFailure: string | null = null;

    // Applies `cand` with confirm/revert; emits chunk-resolved (or, for a kept
    // improve-mode candidate that didn't fully clear, chunk-improved). A
    // failure is NOT emitted here — the chunk may have more finalists to try
    // (a revert restores the prior override state exactly, so the runner-up
    // starts clean); the caller emits one chunk-unresolved after the last.
    const tryApply = async (
      cand: AutotuneCandidate,
      mode: "clear" | "improve" = "clear",
    ): Promise<boolean> => {
      // L10: the kept-trial snapshot is deferred out of the chunk loop — see
      // `pendingSnapshots` above and the drain after the done event. Measured
      // 2026-08-03 at 97.6s, 41% of confirm, entirely to populate a UI list the
      // run itself never reads back.
      const res = await timed("confirm", () =>
        applyAutotuneCandidate(chunkId, cand, mode, { snapshot: false }),
      );
      // L8: how often the approximate search over-promises. Measured 2026-08-02
      // at 3% (1 of 33) — the search is accurate, so confirm cycles are almost
      // never wasted on candidates that get rejected. Kept because it's free and
      // it's the number that killed L7; a future workload could differ.
      confirms += 1;
      if (res.status === "reverted") reverts += 1;
      if (res.status === "kept") {
        applied.set(chunkId, {
          kind: cand.family,
          model: cand.model,
          size: cand.size,
        });
        pendingSnapshots.push({ chunkId, candidate: cand });
        emit({
          type: mode === "clear" || res.remaining === 0 ? "chunk-resolved" : "chunk-improved",
          chunkId,
          candidate: cand,
        });
        if (stopEarly) {
          const s = await getSummary();
          latestRates = { recall: s.recall, mrr: s.mrr, ndcg: s.ndcg };
          barsMet = barsReached(latestRates);
        }
        return true;
      }
      lastFailure = res.detail;
      if (res.status === "skipped") skippedHere = true;
      return false;
    };

    const [chunkRow] = await getChunksByIds([chunkId]);
    const chunkText = chunkRow?.text ?? null;
    if (chunkText === null) {
      emit({ type: "chunk-unresolved", chunkId, reason: "Chunk no longer exists." });
      continue;
    }

    // ---- STAGE 1: chunk size, base model --------------------------------
    for (const size of sizes) {
      if (rungs >= rungCap) break;
      rungs += 1;
      const overlap = overlapFor(size);
      const pieces = await splitText(chunkText, size, overlap);
      const ranks = await timed("search", () =>
        fusedTrialRanks(chunkTargets, chunkId, pieces, "size", cfg.embeddingModel, trialPool, searchCtx),
      );
      attempts += chunkTargets.length;
      emit({ type: "attempt", chunkId, stage: "size", detail: `size ${size}`, attempts });
      const cand = consider(mkCandidate("size", size, overlap, null, chunkTargets, ranks, bars));
      if (cand.score > (bestSize?.score ?? baselineScore)) bestSize = cand;
      if (cand.clears) {
        if (search === "first_success") {
          // A clean Stage-1 size win auto-applies regardless of apply mode (#2).
          // If the confirm reverts it, keep searching (later sizes, then
          // models/combos) instead of writing the chunk off; the failed
          // candidate is not collected, so DECIDE won't retry it.
          resolvedHere = await tryApply(cand);
          if (resolvedHere || skippedHere) break;
        } else {
          candidates.push(cand);
        }
      }
    }
    if (resolvedHere) continue;
    if (skippedHere) {
      emit({ type: "chunk-unresolved", chunkId, reason: lastFailure! });
      continue;
    }

    // ---- STAGE 2: models — full chunk (B) and best sub-size (A) ----------
    for (const model of models) {
      if (rungs >= rungCap) break;
      rungs += 2;
      const rungCands: AutotuneCandidate[] = [];

      const ranksB = await timed("search", () =>
        fusedTrialRanks(chunkTargets, chunkId, [chunkText], "model", model, trialPool, searchCtx),
      );
      attempts += chunkTargets.length;
      emit({ type: "attempt", chunkId, stage: "model", detail: model, attempts });
      const candB = consider(mkCandidate("model", null, null, model, chunkTargets, ranksB, bars));
      if (candB.clears) rungCands.push(candB);

      if (bestSize !== null) {
        const pieces = await splitText(chunkText, bestSize.size!, bestSize.overlap ?? 0);
        const ranksA = await timed("search", () =>
          fusedTrialRanks(chunkTargets, chunkId, pieces, "size+model", model, trialPool, searchCtx),
        );
        attempts += chunkTargets.length;
        emit({
          type: "attempt",
          chunkId,
          stage: "combo",
          detail: `size ${bestSize.size} × ${model}`,
          attempts,
        });
        const candA = consider(
          mkCandidate(
            "size+model",
            bestSize.size,
            bestSize.overlap,
            model,
            chunkTargets,
            ranksA,
            bars,
          ),
        );
        if (candA.clears) rungCands.push(candA);
      }

      candidates.push(...rungCands);
      if (search === "first_success" && rungCands.length > 0) break;
    }

    // ---- STAGE 3: combo fallback — remaining sizes × models --------------
    if (candidates.length === 0) {
      outer: for (const size of sizes) {
        if (size === bestSize?.size) continue; // already tried in Stage 2
        const overlap = overlapFor(size);
        const pieces = await splitText(chunkText, size, overlap);
        for (const model of models) {
          if (rungs >= rungCap) break outer;
          rungs += 1;
          const ranks = await timed("search", () =>
            fusedTrialRanks(chunkTargets, chunkId, pieces, "size+model", model, trialPool, searchCtx),
          );
          attempts += chunkTargets.length;
          emit({
            type: "attempt",
            chunkId,
            stage: "combo",
            detail: `size ${size} × ${model}`,
            attempts,
          });
          const cand = consider(
            mkCandidate("size+model", size, overlap, model, chunkTargets, ranks, bars),
          );
          if (cand.clears) {
            candidates.push(cand);
            if (search === "first_success") break outer;
          }
        }
      }
    }

    // ---- DECIDE ----------------------------------------------------------
    // keepBest fallback: when nothing cleared the bar (or every finalist
    // failed its real-retrieval confirm below), keep the best strictly-
    // improving candidate instead — under improve mode's relaxed-but-real
    // confirm, so it too reverts unless real retrieval actually got better.
    const tryBestEffort = async (): Promise<boolean> =>
      keepBest && !skippedHere && bestEffort !== null
        ? tryApply(bestEffort, "improve")
        : false;

    if (candidates.length === 0) {
      if (!(await tryBestEffort())) {
        emit({
          type: "chunk-unresolved",
          chunkId,
          reason:
            lastFailure ?? "No size, model, or combo cleared the bar (approximate search).",
        });
      }
      continue;
    }
    // Best candidate per family, best-scoring first — score ties go to the
    // cheaper family (familyRank), which decides who gets first shot at the
    // confirm ('exhaustive' compares all collected candidates; 'first_success'
    // typically holds a single rung's).
    const bestByFamily = new Map<CandidateFamily, AutotuneCandidate>();
    for (const c of candidates) {
      const cur = bestByFamily.get(c.family);
      if (!cur || c.score > cur.score) bestByFamily.set(c.family, c);
    }
    const finalists = [...bestByFamily.values()].sort(
      (a, b) => b.score - a.score || familyRank[a.family] - familyRank[b.family],
    );

    if (finalists.length > 1 && applyMode === "choose") {
      pendingChoice += chunkTargets.length;
      emit({
        type: "chunk-choice",
        chunkId,
        fileName: chunkTargets[0].fileName,
        position: chunkTargets[0].position,
        candidates: finalists,
      });
      continue;
    }
    // Try finalists in score order until one survives the real-retrieval
    // confirm — a single over-promising approximation shouldn't cost the
    // chunk its whole turn when a runner-up also cleared. 'skipped' means
    // nothing is failing anymore, so later finalists would fail identically.
    for (const finalist of finalists) {
      resolvedHere = await tryApply(finalist);
      if (resolvedHere || skippedHere) break;
    }
    if (!resolvedHere && !(await tryBestEffort())) {
      emit({ type: "chunk-unresolved", chunkId, reason: lastFailure! });
    }
  }

  // ---- RIPPLE RE-SCORE + SNAPSHOT (A3) -----------------------------------
  // Dirty-set re-score: only questions the run's override changes could have
  // touched go through real retrieval again; the rest are PROVEN unchanged
  // from their stored results and re-stamped (rescoreAffectedQuestions — same
  // end state as a full re-score, minus the redundant retrievals). It also
  // freezes the eval_runs snapshot Appraise reads.
  //
  // Net-changed chunks = the KEPT ones. A reverted candidate restores the
  // chunk's pre-confirm override exactly (applyAutotuneCandidate), so only
  // chunks whose confirm kept a new override differ from the run-start state.
  const endOverrides = new Map(
    (await listOverrides()).map((o) => [o.sourceChunkId, o]),
  );
  const changed: ChangedChunk[] = [...applied.keys()].map((id) => ({
    chunkId: id,
    finalModel: endOverrides.get(id)?.model ?? null,
    startOverridden: startOverrides.has(id),
  }));
  const { skipped } = await timed("rescore", () =>
    rescoreAffectedQuestions(changed, startState, (e) => {
      if (e.type === "score-start") emit({ type: "rescore-start", total: e.total });
      if (e.type === "score-result") {
        emit({ type: "rescore-progress", done: e.done, total: e.total });
      }
    }),
  );

  // ---- OUTCOMES + RUN HEADER ----------------------------------------------
  const final = await getSummary();
  const finalByQ = new Map(final.questions.map((q) => [q.questionId, q]));

  let resolved = 0;
  let improved = 0; // still below the bar, but a targeted metric's value rose
  const outcomes: AutotuneOutcome[] = [];
  for (const t of targets) {
    const after = finalByQ.get(t.questionId);
    const stillFailing = after ? failingMetrics(after, criteria) : t.metrics;
    if (stillFailing.length === 0) {
      resolved += 1;
    } else if (
      after !== undefined &&
      t.metrics.some((m) => {
        const beforeValue =
          m === "recall" ? (t.beforeHit ? 1 : 0) : m === "mrr" ? (t.beforeRr ?? 0) : (t.beforeNdcg ?? 0);
        return pairValue(after, m) > beforeValue + 1e-9;
      })
    ) {
      improved += 1;
    }
    const ov = applied.get(t.sourceChunkId) ?? null;
    for (const m of t.metrics) {
      outcomes.push({
        questionId: t.questionId,
        sourceChunkId: t.sourceChunkId,
        metric: m,
        beforeValue:
          m === "recall" ? (t.beforeHit ? 1 : 0) : m === "mrr" ? t.beforeRr : t.beforeNdcg,
        beforeRank: t.beforeRank,
        afterValue:
          after === undefined
            ? null
            : m === "recall"
              ? after.hit === null
                ? null
                : after.hit
                  ? 1
                  : 0
              : m === "mrr"
                ? after.rr
                : after.ndcg,
        afterRank: after?.foundRank ?? null,
        overrideKind: ov?.kind ?? null,
        overrideModel: ov?.model ?? null,
        overrideSize: ov?.size ?? null,
      });
    }
  }

  // Stopped BEFORE the history insert: the number describes the run's work, not
  // the bookkeeping that records it.
  const durationMs = Math.round(performance.now() - t0);

  await insertAutotuneRun(
    {
      recallK: recallTargeting ? recallK : null,
      recallMinRate: criteria.recall.minRate,
      mrrK: mrrTargeting ? mrrK : null,
      mrrMinRate: criteria.mrr.minRate,
      ndcgK: ndcgTargeting ? ndcgK : null,
      ndcgMinRate: criteria.ndcg.minRate,
      targeted: targets.length,
      resolved,
      unresolved: targets.length - resolved,
      improved,
      attempts,
    },
    outcomes,
  );

  console.log(
    `[rag:autotune] done: targeted=${targets.length} resolved=${resolved} ` +
      `improved=${improved} pendingChoice=${pendingChoice} attempts=${attempts} ` +
      `rescoreSkipped=${skipped} in ${durationMs}ms ` +
      `(search=${Math.round(phase.search)}ms confirm=${Math.round(phase.confirm)}ms ` +
      `rescore=${Math.round(phase.rescore)}ms) ` +
      `confirms=${confirms} reverts=${reverts}`,
  );
  emit({
    type: "autotune-done",
    cancelled: shouldStop(),
    targeted: targets.length,
    resolved,
    unresolved: targets.length - resolved,
    improved,
    pendingChoice,
    attempts,
    recall: final.recall,
    mrr: final.mrr,
    ndcg: final.ndcg,
    durationMs,
  });

  // L10: the deferred snapshots. AFTER the done event on purpose — the caller
  // already has its result, so this no longer sits on the critical path. Still
  // INSIDE the request handler: the NDJSON stream stays open until this function
  // returns, and moving it past that would let the platform kill the work.
  // Best-effort exactly as it was inline (saveKeptTrialSnapshot swallows its own
  // failures), so a snapshot that fails never affects the applied override.
  for (const { chunkId, candidate } of pendingSnapshots) {
    await saveKeptTrialSnapshot(chunkId, candidate);
  }
}
