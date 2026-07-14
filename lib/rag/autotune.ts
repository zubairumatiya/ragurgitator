// ---------------------------------------------------------------------------
// AUTOTUNE ENGINE (Phase C of docs/eval-autotuning-plan.md).
//
// For every question below its min-rate (D1), search per chunk for a re-shape
// that lifts it: chunk SIZE first (Stage 1), then alternate MODELS — both the
// full chunk and the best sub-size under each model (Stage 2), then remaining
// size × model combos (Stage 3) — per the A2/A4 ladder. A winning candidate is
// persisted as a per-chunk override (pieces, Phase B), CONFIRMED through real
// rank-fused retrieval (reverted if the approximation over-promised), and the run ends
// with one full-corpus re-score (A3) + an eval_runs snapshot (feeds Appraise)
// + an autotune_runs history row.
//
// The inner search reuses the EXISTING ephemeral experiments, so it is a LOCAL
// APPROXIMATION on two axes:
//   - Stage 1 ranks sub-pieces by exact full-scan in the BASE space
//     (runRechunkExperiment); Stages 2–3 rank within a small candidate POOL
//     (the distractors the chunk's questions already retrieved) under the alt
//     model — "re-orders the pool better", not true corpus recall.
//   - Per-question nDCG can't be recomputed cheaply mid-search, so an
//     nDCG-failing question "clears" approximately when its ground-truth rank
//     lands within ndcg_k without regressing. The per-chunk confirm re-score
//     (real retrieval, real metrics) is the arbiter either way.
// ---------------------------------------------------------------------------
import { autotuneModelLadder } from "@/lib/config";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  insertAutotuneRun,
  listIgnoredQuestionIds,
  type AutotuneOutcome,
} from "@/lib/rag/autotuneStore";
import { splitText } from "@/lib/rag/chunker";
import { cosine, embedDocsCached, embedQueryCached } from "@/lib/rag/embedCache";
import { isProviderAvailable, modelSpec } from "@/lib/rag/embeddingModels";
import {
  rescoreAllQuestions,
  runRechunkExperiment,
  scoreQuestionNow,
  setChunkModelOverride,
  setChunkSizeModelOverride,
  setChunkSizeOverride,
} from "@/lib/rag/eval";
import { effectiveK, type EvalCriteria } from "@/lib/rag/evalSettingsStore";
import {
  getChunksByIds,
  getSummary,
  type QuestionDetail,
} from "@/lib/rag/evalStore";
import { clearChunkOverride } from "@/lib/rag/overrideStore";

export type AutotuneMetric = "recall" | "mrr" | "ndcg";
export type CandidateFamily = "size" | "model" | "size+model";

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
      // apply='choose' and more than one FAMILY cleared: nothing applied; the
      // user picks via POST /api/eval/autotune/apply after the run.
      type: "chunk-choice";
      chunkId: string;
      fileName: string;
      position: number | null;
      candidates: AutotuneCandidate[];
    }
  | { type: "chunk-unresolved"; chunkId: string; reason: string }
  | { type: "rescore-start"; total: number }
  | { type: "rescore-progress"; done: number; total: number }
  | {
      type: "autotune-done";
      targeted: number;
      resolved: number;
      unresolved: number;
      pendingChoice: number;
      attempts: number;
      recall: number | null;
      mrr: number | null;
      ndcg: number | null;
    }
  | { type: "error"; message: string };

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
  retrievedIds: string[];
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
// config's base model and any provider without a key/weights.
function usableModelLadder(): string[] {
  const base = activeConfig().embeddingModel;
  return autotuneModelLadder.filter((id) => {
    if (id === base) return false;
    try {
      return isProviderAvailable(modelSpec(id).provider);
    } catch {
      return false;
    }
  });
}

// Stage-2/3 pool trial: rank candidate texts (re-split pieces, or the whole
// chunk) against the chunk's distractor pool, everything embedded under `model`.
// Returns each target question's best candidate rank WITHIN the pool (1-based).
// Same methodology as runModelTrial, generalized to N candidate texts.
async function poolTrialRanks(
  targets: TargetQuestion[],
  candidateTexts: string[],
  poolTexts: string[],
  model: string,
): Promise<(number | null)[]> {
  const candVecs = await embedDocsCached(candidateTexts, model);
  const poolVecs = await embedDocsCached(poolTexts, model);
  const ranks: (number | null)[] = [];
  for (const t of targets) {
    const qv = await embedQueryCached(t.question, model);
    const bestCand = Math.max(...candVecs.map((v) => cosine(qv, v)));
    // Rank = 1 + how many pool distractors beat the best candidate piece.
    const beaten = poolVecs.filter((v) => cosine(qv, v) > bestCand).length;
    ranks.push(beaten + 1);
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

export type ApplyResult = {
  status: "kept" | "reverted" | "failed";
  detail: string;
};

// Promote → persist → CONFIRM (§5.3): apply the override, re-score the chunk's
// own questions through real rank-fused retrieval, and keep it only if the chunk's
// failing (question, metric) set shrank with no new failures — otherwise revert
// the override and re-score again so the stored results stay truthful. Exported
// for the post-run choice endpoint (POST /api/eval/autotune/apply).
export async function applyAutotuneCandidate(
  chunkId: string,
  candidate: Pick<AutotuneCandidate, "family" | "size" | "overlap" | "model">,
): Promise<ApplyResult> {
  const before = await getSummary();
  const criteria = before.criteria;
  const chunkQs = before.questions.filter((q) => q.sourceChunkId === chunkId);
  if (chunkQs.length === 0) {
    return { status: "failed", detail: "Chunk has no questions under this config." };
  }
  const beforeFailing = failingPairs(chunkQs, criteria);

  const persisted = await persistCandidate(chunkId, candidate);
  if (persisted !== "ok") {
    return { status: "failed", detail: `Could not persist override (${persisted}).` };
  }

  const rescoreChunk = async () => {
    for (const q of chunkQs) await scoreQuestionNow(q.questionId);
  };
  await rescoreChunk();

  const after = await getSummary();
  const afterFailing = failingPairs(
    after.questions.filter((q) => q.sourceChunkId === chunkId),
    criteria,
  );
  const newFailure = [...afterFailing].some((p) => !beforeFailing.has(p));
  const progressed = afterFailing.size < beforeFailing.size;

  if (newFailure || !progressed) {
    await clearChunkOverride(chunkId);
    await rescoreChunk();
    return {
      status: "reverted",
      detail: newFailure
        ? "Override regressed a previously-passing question on real retrieval."
        : "Override made no real-retrieval progress (approximation over-promised).",
    };
  }
  return {
    status: "kept",
    detail: `Failing checks ${beforeFailing.size} → ${afterFailing.size}.`,
  };
}

// The run itself — driven by the streamed POST /api/eval/autotune route.
export async function runAutotune(emit: Emit = () => {}): Promise<void> {
  const t0 = performance.now();
  const cfg = activeConfig();
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

  // Targets: every fresh below-bar question, minus ignores, grouped by chunk.
  const targets: TargetQuestion[] = [];
  for (const q of summary.questions) {
    if (ignored.has(q.questionId)) continue;
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
      retrievedIds: q.retrievedIds ?? [],
    });
  }

  const byChunk = new Map<string, TargetQuestion[]>();
  for (const t of targets) {
    const list = byChunk.get(t.sourceChunkId) ?? [];
    list.push(t);
    byChunk.set(t.sourceChunkId, list);
  }

  const search = criteria.autotune.search;
  const applyMode = criteria.autotune.apply;
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
      pendingChoice: 0,
      attempts: 0,
      recall: summary.recall,
      mrr: summary.mrr,
      ndcg: summary.ndcg,
    });
    return;
  }

  const sizes = criteria.autotune.sizeLadder;
  const overlapFor = (size: number) =>
    Math.min(size - 1, Math.max(0, Math.round(size * criteria.autotune.overlapPct)));
  const models = usableModelLadder();
  // Per-chunk cap on search RUNGS (a rung = one size, or one model's two
  // branches) so even exhaustive mode is bounded (A4/A5).
  const rungCap = sizes.length + 2 * models.length + 6;

  let attempts = 0;
  let pendingChoice = 0;
  // Applied override per chunk, for the outcome rows.
  const applied = new Map<
    string,
    { kind: CandidateFamily; model: string | null; size: number | null }
  >();

  let chunkIndex = 0;
  for (const [chunkId, chunkTargets] of byChunk) {
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

    const baselineScore = chunkTargets.reduce(
      (s, t) => s + (t.beforeRank === null ? 0 : 1 / t.beforeRank),
      0,
    );
    const candidates: AutotuneCandidate[] = [];
    let bestSize: AutotuneCandidate | null = null; // best IMPROVING stage-1 size
    let rungs = 0;
    let resolvedHere = false;

    // Applies `cand` with confirm/revert and emits the outcome. Returns true
    // when the override was kept (chunk done).
    const tryApply = async (cand: AutotuneCandidate): Promise<boolean> => {
      const res = await applyAutotuneCandidate(chunkId, cand);
      if (res.status === "kept") {
        applied.set(chunkId, {
          kind: cand.family,
          model: cand.model,
          size: cand.size,
        });
        emit({ type: "chunk-resolved", chunkId, candidate: cand });
        return true;
      }
      emit({ type: "chunk-unresolved", chunkId, reason: res.detail });
      return false;
    };

    // ---- STAGE 1: chunk size, base model --------------------------------
    for (const size of sizes) {
      if (rungs >= rungCap) break;
      rungs += 1;
      const overlap = overlapFor(size);
      const ranks: (number | null)[] = [];
      for (const t of chunkTargets) {
        const res = await runRechunkExperiment(t.questionId, size, overlap);
        ranks.push(res?.bestSubRank ?? null);
        attempts += 1;
      }
      emit({ type: "attempt", chunkId, stage: "size", detail: `size ${size}`, attempts });
      const cand = mkCandidate("size", size, overlap, null, chunkTargets, ranks, bars);
      if (cand.score > (bestSize?.score ?? baselineScore)) bestSize = cand;
      if (cand.clears) {
        candidates.push(cand);
        if (search === "first_success") {
          // A clean Stage-1 size win auto-applies regardless of apply mode (#2).
          resolvedHere = await tryApply(cand);
          break;
        }
      }
    }
    if (resolvedHere || (search === "first_success" && candidates.length > 0)) continue;

    // Distractor pool for the model stages: everything the chunk's targeted
    // questions retrieved, minus the chunk itself.
    const poolIds = [
      ...new Set(chunkTargets.flatMap((t) => t.retrievedIds)),
    ].filter((id) => id !== chunkId);
    const [chunkRow] = await getChunksByIds([chunkId]);
    const pool = await getChunksByIds(poolIds);
    const poolTexts = pool.map((p) => p.text);
    const chunkText = chunkRow?.text ?? null;

    // ---- STAGE 2: models — full chunk (B) and best sub-size (A) ----------
    if (chunkText !== null) {
      for (const model of models) {
        if (rungs >= rungCap) break;
        rungs += 2;
        const rungCands: AutotuneCandidate[] = [];

        const ranksB = await poolTrialRanks(chunkTargets, [chunkText], poolTexts, model);
        attempts += chunkTargets.length;
        emit({ type: "attempt", chunkId, stage: "model", detail: model, attempts });
        const candB = mkCandidate("model", null, null, model, chunkTargets, ranksB, bars);
        if (candB.clears) rungCands.push(candB);

        if (bestSize !== null) {
          const pieces = await splitText(chunkText, bestSize.size!, bestSize.overlap ?? 0);
          const ranksA = await poolTrialRanks(chunkTargets, pieces, poolTexts, model);
          attempts += chunkTargets.length;
          emit({
            type: "attempt",
            chunkId,
            stage: "combo",
            detail: `size ${bestSize.size} × ${model}`,
            attempts,
          });
          const candA = mkCandidate(
            "size+model",
            bestSize.size,
            bestSize.overlap,
            model,
            chunkTargets,
            ranksA,
            bars,
          );
          if (candA.clears) rungCands.push(candA);
        }

        candidates.push(...rungCands);
        if (search === "first_success" && rungCands.length > 0) break;
      }

      // ---- STAGE 3: combo fallback — remaining sizes × models ------------
      if (candidates.length === 0) {
        outer: for (const size of sizes) {
          if (size === bestSize?.size) continue; // already tried in Stage 2
          const overlap = overlapFor(size);
          const pieces = await splitText(chunkText, size, overlap);
          for (const model of models) {
            if (rungs >= rungCap) break outer;
            rungs += 1;
            const ranks = await poolTrialRanks(chunkTargets, pieces, poolTexts, model);
            attempts += chunkTargets.length;
            emit({
              type: "attempt",
              chunkId,
              stage: "combo",
              detail: `size ${size} × ${model}`,
              attempts,
            });
            const cand = mkCandidate(
              "size+model",
              size,
              overlap,
              model,
              chunkTargets,
              ranks,
              bars,
            );
            if (cand.clears) {
              candidates.push(cand);
              if (search === "first_success") break outer;
            }
          }
        }
      }
    }

    // ---- DECIDE ----------------------------------------------------------
    if (candidates.length === 0) {
      emit({
        type: "chunk-unresolved",
        chunkId,
        reason: "No size, model, or combo cleared the bar (approximate search).",
      });
      continue;
    }
    // Best candidate per family, best-scoring first ('exhaustive' compares all
    // collected candidates; 'first_success' typically holds a single rung's).
    const bestByFamily = new Map<CandidateFamily, AutotuneCandidate>();
    for (const c of candidates) {
      const cur = bestByFamily.get(c.family);
      if (!cur || c.score > cur.score) bestByFamily.set(c.family, c);
    }
    const finalists = [...bestByFamily.values()].sort((a, b) => b.score - a.score);

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
    await tryApply(finalists[0]);
  }

  // ---- RIPPLE RE-SCORE + SNAPSHOT (A3) -----------------------------------
  // rescoreAllQuestions re-runs every labeled question through real retrieval
  // and freezes the eval_runs snapshot Appraise reads.
  await rescoreAllQuestions((e) => {
    if (e.type === "score-start") emit({ type: "rescore-start", total: e.total });
    if (e.type === "score-result") {
      emit({ type: "rescore-progress", done: e.done, total: e.total });
    }
  });

  // ---- OUTCOMES + RUN HEADER ----------------------------------------------
  const final = await getSummary();
  const finalByQ = new Map(final.questions.map((q) => [q.questionId, q]));

  let resolved = 0;
  const outcomes: AutotuneOutcome[] = [];
  for (const t of targets) {
    const after = finalByQ.get(t.questionId);
    const stillFailing = after ? failingMetrics(after, criteria) : t.metrics;
    if (stillFailing.length === 0) resolved += 1;
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
      attempts,
    },
    outcomes,
  );

  console.log(
    `[rag:autotune] done: targeted=${targets.length} resolved=${resolved} ` +
      `pendingChoice=${pendingChoice} attempts=${attempts} ` +
      `in ${Math.round(performance.now() - t0)}ms`,
  );
  emit({
    type: "autotune-done",
    targeted: targets.length,
    resolved,
    unresolved: targets.length - resolved,
    pendingChoice,
    attempts,
    recall: final.recall,
    mrr: final.mrr,
    ndcg: final.ndcg,
  });
}
