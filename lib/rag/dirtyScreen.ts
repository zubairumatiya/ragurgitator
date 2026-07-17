// ---------------------------------------------------------------------------
// THE DIRTY SCREEN — the pure decision core of eval.rescoreAffectedQuestions.
//
// After an autotune run, only the chunks whose override state net-changed can
// affect any stored eval result; every other chunk's vectors are untouched.
// Given one question's stored result (scored under the RUN-START override
// state) and, per changed chunk, two precomputed similarities, this decides
// whether the stored result is PROVEN identical under the run-end state
// ('clean' → re-stamp its fingerprint) or must re-run retrieval ('dirty').
//
// A changed chunk can ripple into a stored result in exactly three ways:
//   1. It was IN the stored retrieved list — its move (or its pieces'
//      removal) shifts the stored ranks directly.
//   2. Its NEW pieces enter the merged top-depth — possible only if their
//      best sim reaches the depth-th competitor sim in the SAME model space
//      (cutoffs.models[m], stored with the result — 0028).
//   3. Its base-lane membership changes inside the stored deep list (first
//      override = leaves the base ANN; cleared = re-enters), perturbing the
//      competitor pools every override space ranks against. Bounded by
//      cutoffs.deep, the sim of the deep list's last candidate.
//
// Conservative by construction: any missing input (no cutoffs, unknown sim,
// different scoring depth, a result from any state other than run-start)
// means 'dirty' — the screen never guesses. Comparisons use ≥ so ties count
// as dirty too.
//
// Known approximation (accepted, documented): when a chunk's base-lane
// membership changes WITHIN the deep list but below the top-depth, the swap
// at the bottom of the competitor pool can shift another overridden chunk's
// fractional rank by ±1 — screen 3 marks all such questions dirty rather
// than reasoning about the swapped competitor, so the screen stays sound.
// ---------------------------------------------------------------------------
import type { ScreenCutoffs } from "@/lib/rag/retriever";

// One net-changed chunk, with the two sims the screens compare for ONE
// question. null sim = not computable from caches (→ dirty, never guessed).
export type ChangedChunkSims = {
  chunkId: string;
  // The chunk's override model in the run-END state; null = override cleared.
  finalModel: string | null;
  // It had an override (any kind) at run start.
  startOverridden: boolean;
  // cosine(question's base query vector, chunk's base embedding).
  baseSim: number | null;
  // Best cosine(question's query vector under finalModel, new override piece).
  // Irrelevant (and ignored) when finalModel is null.
  bestPieceSim: number | null;
};

export function screenStoredResult(args: {
  depth: number; // current scoring depth — must match cutoffs.depth
  baseModel: string;
  startState: string; // run-start fingerprint — the only screenable state
  retrievalState: string | null; // state the stored result was scored under
  editStale: boolean; // question text edited since it was scored
  retrievedIds: string[]; // the stored retrieved superset
  cutoffs: ScreenCutoffs | null; // 0028; null = pre-migration result
  changed: ChangedChunkSims[];
}): "dirty" | "clean" {
  const { depth, baseModel, startState, retrievalState, editStale, retrievedIds, cutoffs } =
    args;
  if (editStale) return "dirty";
  if (retrievalState === null || retrievalState !== startState) return "dirty";
  if (!cutoffs || cutoffs.depth !== depth) return "dirty";

  for (const x of args.changed) {
    // Screen 1: visible in the stored result.
    if (retrievedIds.includes(x.chunkId)) return "dirty";
    if (x.baseSim === null) return "dirty";

    if (x.finalModel !== null) {
      // Screen 2: can the new pieces crack the merged top-depth?
      const cut = cutoffs.models[x.finalModel];
      if (cut === undefined || x.bestPieceSim === null) return "dirty";
      if (x.bestPieceSim >= cut) return "dirty";

      // Screen 3: first-time override leaves the base lane. Results scored
      // under 'baseline' had no fusion pools to perturb, so only fused-path
      // results care.
      if (!x.startOverridden && retrievalState !== "baseline") {
        if (cutoffs.deep === null || x.baseSim >= cutoffs.deep) return "dirty";
      }
    } else {
      // Cleared: the chunk re-enters the base lane. Below the stored depth
      // cutoff it can't enter the top-depth; below the deep cutoff it can't
      // even join the competitor pools.
      const cutBase = cutoffs.models[baseModel];
      if (cutBase === undefined || x.baseSim >= cutBase) return "dirty";
      if (cutoffs.deep === null || x.baseSim >= cutoffs.deep) return "dirty";
    }
  }
  return "clean";
}
