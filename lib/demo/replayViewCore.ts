// WHAT A VISITOR SEES OF THE MATRIX — the pure half of phase 3 of
// docs/demo-cache-replay-plan.md.
//
// The banked matrix (phases 1–2) is the master's whole pooled set: one cosine per
// pair per candidate model, in the master's own order. A guest has walked some
// distance into it — `n` generated pairs, screened or not — and holds their own
// judged shadow rows. This module turns those three facts into the four numbers
// the page prints, and it does it by RE-RUNNING the app's own arithmetic rather
// than by interpolating between banked answers: `scoreFromSims` here is the same
// function `scoreModel` calls on a real account.
//
// SPLIT OUT OF replayView.ts for the reason replayCore is split out of replay:
// none of this touches a database, a request scope or a config, so it is
// unit-testable as a table of inputs. Nothing here imports "server-only".
//
// THE ORDER IS THE CONTRACT. `matrix.pairs` and each row of `matrix.sims` are
// parallel arrays, so a selection is a list of INDICES into both, and "the first
// n" means the first n in the master's order — which is stable across every hop
// because phase 1 made pair identity text-derived.
import type { ReplayMatrix, ReplayPair, ReplayProgress } from "@/lib/demo/replayCore";
import { simsFor } from "@/lib/demo/replayCore";
import { EMBEDDING_MODELS } from "@/lib/rag/embeddingModels";
import type { LeaderboardRow, SweepResult } from "@/lib/rag/keyModelSweep";
import { scoreFromSims, type PairLabelLike } from "@/lib/rag/keyModelSweepCore";
import type { EffectiveAcceptTarget } from "@/lib/rag/semanticCache";
import { spaceOf } from "@/lib/rag/semanticCacheCore";

// One pair the visitor has reached, as an index into the matrix plus the label it
// is scored under. The label is NOT always `matrix.pairs[index].label`: a shadow
// row carries the GUEST's own verdict, so hand-judging one in §2 changes what §4
// scores it as. That is the causal chain the replay exists to make real.
export type SelectedPair = { index: number; label: PairLabelLike };

// The pair-bank section's counts line, over the generated half only — §1 counts
// what the visitor has generated, not what the pool scores.
export type BankCounts = {
  // Every generated pair reached, INCLUDING the quarantined ones. pairStats
  // counts the same way, and for the same reason: a quarantined pair is still
  // generated and still occupies its origin question; it is simply no longer
  // scored.
  total: number;
  same: number;
  different: number;
  // Zero until the visitor screens, because the quarantine is what the screen
  // DISCOVERS. Presenting it before then would answer a question the visitor has
  // not paid for and make the screen button a no-op that reports a number.
  quarantined: number;
  // The mirror image: everything reached is unscreened until the screen runs.
  unscreened: number;
  // How much of the matrix's generated half is still ahead of them — the ceiling
  // the generate slider sizes itself from.
  remaining: number;
};

export type ReplaySelection = {
  // In matrix order, which is what makes a leaderboard's `pairsScored` and a
  // floor's `comparisons` describe the same set.
  rows: SelectedPair[];
  bank: BankCounts;
  // The pooled counts the leaderboard header prints — over `rows`, so the shadow
  // half is the guest's own and the generated half is what they have reached.
  pairs: SweepResult["pairs"];
};

const isGenerated = (p: ReplayPair) => p.source === "generated";

// THE SELECTION, and the three rules that make it a replay rather than a
// simulation:
//
//   1. GENERATED pairs are the first `progress.generated` of them in the
//      master's order. Any n, exactly as the real generate control behaves —
//      there is no nearest checkpoint to round to.
//   2. SCREENING is what admits them. A visitor who has not screened scores the
//      quarantined pairs under the generator's label (that is what an unscreened
//      pair IS); screening drops them, which is the same drop `listPairs`
//      performs on a real account and the reason the numbers move when it runs.
//   3. The SHADOW half is the guest's, not the master's. A matrix shadow pair is
//      scored only if the guest holds a judged row for it, under the verdict THEY
//      hold — so the leaderboard's header adds up to what is in their workspace,
//      and judging a queued row moves it.
export function selectReplay(
  matrix: ReplayMatrix,
  progress: ReplayProgress,
  // The guest's own judged shadow rows, by pair identity. A hash the matrix does
  // not carry is simply absent from the pool: a pair with no banked cosine cannot
  // be scored, and inventing one is the single thing this file must never do.
  shadowLabels: Map<string, PairLabelLike>,
): ReplaySelection {
  const generatedIdx = matrix.pairs
    .map((p, i) => (isGenerated(p) ? i : -1))
    .filter((i) => i !== -1);
  const reached = generatedIdx.slice(0, Math.max(0, Math.min(progress.generated, generatedIdx.length)));
  const reachedSet = new Set(reached);

  const rows: SelectedPair[] = [];
  for (const [index, pair] of matrix.pairs.entries()) {
    if (isGenerated(pair)) {
      if (!reachedSet.has(index)) continue;
      if (progress.screened && pair.quarantined) continue;
      rows.push({ index, label: pair.label });
      continue;
    }
    const label = shadowLabels.get(pair.hash);
    if (label) rows.push({ index, label });
  }

  const reachedPairs = reached.map((i) => matrix.pairs[i]);
  const bank: BankCounts = {
    total: reachedPairs.length,
    same: reachedPairs.filter((p) => p.label === "same").length,
    different: reachedPairs.filter((p) => p.label === "different").length,
    quarantined: progress.screened ? reachedPairs.filter((p) => p.quarantined).length : 0,
    unscreened: progress.screened ? 0 : reachedPairs.length,
    remaining: generatedIdx.length - reached.length,
  };

  return {
    rows,
    bank,
    pairs: {
      total: rows.length,
      shadow: rows.filter((r) => !isGenerated(matrix.pairs[r.index])).length,
      generated: rows.filter((r) => isGenerated(matrix.pairs[r.index])).length,
      same: rows.filter((r) => r.label === "same").length,
      different: rows.filter((r) => r.label === "different").length,
    },
  };
}

// ONE LEADERBOARD ROW, replayed. Everything the real sweep derives from the
// cosines comes from scoreFromSims; everything else on the row is metadata the
// registry already holds.
//
// AVAILABILITY IS THE PUBLISH'S, NOT THE VISITOR'S, and that is the one place
// this deliberately parts company with runKeyModelSweep. A leaderboard row says
// whether a model WAS SCORED, and it was — on the master, with the master's keys.
// The demo carries one provider's key, so asking `availableProviders()` here
// would blank ten of eleven rows that have real numbers sitting behind them.
function replayRow(
  matrix: ReplayMatrix,
  model: string,
  selection: ReplaySelection,
): LeaderboardRow {
  const spec = EMBEDDING_MODELS[model];
  const base = {
    model,
    space: spaceOf(model),
    dimension: spec?.dimension ?? 0,
    provider: spec?.provider ?? "unknown",
    threshold: null,
    recallAtThreshold: null,
    auc: null,
    precisionAtThreshold: null,
    pairsScored: 0,
    samePairs: selection.pairs.same,
    differentPairs: selection.pairs.different,
    calibration: null,
    error: null,
  };
  if (!spec) return { ...base, available: false, reason: "not in EMBEDDING_MODELS" };
  const sims = simsFor(matrix, model);
  // Null is a model the publish could not score — an unreachable provider, or a
  // sweep cancelled before it got here. Reported rather than dropped, exactly as
  // the real sweep reports one: an absent row reads as a bad score.
  if (!sims) return { ...base, available: false, reason: "not scored in this build" };
  if (selection.rows.length === 0) return { ...base, available: true, reason: "no pairs to score" };

  const scored = selection.rows.map((r) => ({ sim: sims[r.index], label: r.label }));
  const s = scoreFromSims(scored, matrix.target, matrix.minSamples);
  return {
    ...base,
    available: true,
    reason: null,
    threshold: s.threshold,
    recallAtThreshold: s.recall,
    auc: s.aucValue,
    precisionAtThreshold: s.precision,
    pairsScored: scored.length,
    calibration: s.calibration,
  };
}

// THE WHOLE LEADERBOARD, in the shape the panel already renders.
//
// The TARGET and minSamples come from the matrix rather than from the guest's
// config: they are the inputs the master measured under, and reading them back
// from a workspace whose settings a visitor can edit would let a moved dial
// silently restate what was measured. `targetSource` is still the guest's own,
// because it only names WHOSE dial the number came from, and the panel prints
// that config's label beside it.
export function replaySweep(
  matrix: ReplayMatrix,
  selection: ReplaySelection,
  targetSource: EffectiveAcceptTarget,
): SweepResult {
  const rows = matrix.models.map((model) => replayRow(matrix, model, selection));
  // Recall@τ descending, AUC breaking ties — runKeyModelSweep's comparator, and
  // it has to be: two orderings of the same numbers would be two leaderboards.
  rows.sort(
    (a, b) =>
      (b.recallAtThreshold ?? -1) - (a.recallAtThreshold ?? -1) ||
      (b.auc ?? -1) - (a.auc ?? -1),
  );
  return {
    cancelled: false,
    target: matrix.target,
    targetSource: { ...targetSource, target: matrix.target },
    minSamples: matrix.minSamples,
    pairs: selection.pairs,
    rows,
  };
}

// THE PAIR-BANK COLLISION FLOOR, which for a guest reads 0 today and is the
// clearest sign the demo ships the wrong artifact: the floor needs a vector for
// every hard negative, and `embedding_cache` is the 107 MB the clone deliberately
// leaves behind. Under the matrix it is one column, subsetted — the max cosine
// among the `different` GENERATED pairs the visitor has reached.
//
// GENERATED ONLY, matching pairBankFloor: this population is the LLM-written hard
// negatives, and pooling the guest's rejected traffic into it would report the
// traffic floor under the pair bank's name.
//
// `missingVectors` carries its real meaning across. On a real account it counts
// hard negatives with no banked vector; here it counts the ones with no banked
// COSINE, which is the same statement about the same gap — the floor is a MAX, so
// a dropped pair could only ever have raised it.
export function replayPairFloor(
  matrix: ReplayMatrix,
  selection: ReplaySelection,
  model: string,
): { floor: number | null; comparisons: number; missingVectors: number } {
  const sims = simsFor(matrix, model);
  const different = selection.rows.filter(
    (r) => r.label === "different" && isGenerated(matrix.pairs[r.index]),
  );
  if (!sims) return { floor: null, comparisons: 0, missingVectors: different.length };
  let floor: number | null = null;
  for (const r of different) {
    const sim = sims[r.index];
    if (floor === null || sim > floor) floor = sim;
  }
  return { floor, comparisons: different.length, missingVectors: 0 };
}
