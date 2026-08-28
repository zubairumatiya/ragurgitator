// CACHE-KEY MODEL SWEEP.
//
// Scores every candidate embedding model on the same pooled pair set and emits one
// leaderboard row each. Deliberately NOT autotune: ~9 models × a couple of
// preprocessing variants is small enough to enumerate, so this is a table you sort,
// not a search you run.
//
// THE OBJECTIVE IS RECALL AT A FIXED PRECISION. Each model gets its OWN τ — the
// lowest threshold whose served set still clears the caller's precision target —
// and is then scored on how many of the available same-answer pairs that τ serves.
// The target rides back out as `targetSource`, because this page is not
// config-scoped and an unattributed "99%" would hide whose dial set it.
//
// Holding precision equal is what makes the models comparable at all: cosine scales
// differ between embedding spaces, so raw similarity magnitudes never can be. AUC
// rides along as a scale-free sanity check and tiebreak, never as the objective.
//
// COST IS EMBEDDING-ONLY — no LLM calls, no re-ingestion, no chunks table touched.
// Every text goes through embedQueryCached, so it's content-addressed, metered, and
// nearly free on re-runs.
//
// CANCELLATION. The full sweep is a long embedding run, so it takes a
// `shouldStop` flag like every other long job here (never a throw — see
// cancelRegistry). Stopping keeps everything already banked: embedQueryCached
// persists each vector as it goes, so a cancelled run still warms the cache and
// still returns the models it managed to score.
import { config } from "@/lib/config";
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import { embedQueriesCached } from "@/lib/rag/embedCache";
import { EMBEDDING_MODELS } from "@/lib/rag/embeddingModels";
import { availableProviders } from "@/lib/rag/providerAvailability";
import type { EffectiveAcceptTarget } from "@/lib/rag/semanticCache";
import { cosine, spaceOf, type CalibrationResult } from "@/lib/rag/semanticCacheCore";
import { poolPairs, scoreFromSims, type SweepPair } from "@/lib/rag/keyModelSweepCore";
import {
  listPairs,
  quarantinedPairs,
  type PairLabel,
} from "@/lib/rag/semanticCachePairs";

// The scored-pair shape and the pooling rule both live in the DB-free core now.
// Re-exported here because this module is the one callers reach for, and because
// the assignments in shadowPairs/pooledPairs below are the seam where the core's
// restated label vocabularies meet the real PairLabel and PairDifficulty — add a
// third label to either and those assignments stop compiling.
export type { SweepPair } from "@/lib/rag/keyModelSweepCore";

// A SINK FOR THE SWEEP'S RAW ARITHMETIC — phase 2 of
// docs/demo-cache-replay-plan.md.
//
// Everything the leaderboard prints is a pure function of `scored`, one
// `{sim, label}[]` per candidate over one pooled pair set. The embeddings that
// produce those cosines are what a guest cannot afford; the cosines themselves
// are ~30 kB, which is why the demo banks them and replays the arithmetic rather
// than banking the answer. This is how the publish gets at them.
//
// OFFLINE ONLY, exactly like `includeQuarantined` beside it: no route passes an
// observer, and the only caller is lib/demo/captureMatrix at publish time. It is
// a sink and not a return value so that a cancelled sweep still hands over what
// it managed to score, and so the ordinary path allocates nothing.
//
// `onScored` fires ONLY for a model that scored the whole set — an unavailable
// provider, a failure and a cancellation each push a leaderboard row without
// ever calling it, which is what lets the capture record that model as null
// rather than as a row of zeros.
export type SweepObserver = {
  onPairs?(pairs: SweepPair[]): void;
  onScored?(model: string, scored: { sim: number; label: PairLabel }[]): void;
};

export type LeaderboardRow = {
  model: string;
  space: string;
  dimension: number;
  provider: string;
  // Unavailable models are REPORTED, not dropped: a missing row otherwise looks
  // like a model that scored badly rather than one that was never run.
  available: boolean;
  reason: string | null;
  // --- the numbers (null when the model didn't run) ---
  threshold: number | null; // τ at the precision target
  recallAtThreshold: number | null; // THE metric — savings captured at that safety level
  auc: number | null; // scale-free sanity/tiebreak
  precisionAtThreshold: number | null; // the achieved precision at τ (≥ target)
  pairsScored: number;
  samePairs: number;
  differentPairs: number;
  calibration: CalibrationResult | null; // full curve, for a detail view
  error: string | null;
};

export type SweepResult = {
  // True when the run stopped early. The rows it did produce are real results —
  // every model is scored on the same pair set, independently of the others — so
  // the table stays readable; it is just shorter than the candidate list.
  cancelled: boolean;
  target: number; // the precision held equal across models
  // Whose dial that target came from. The sweep is global (one pooled pair set,
  // every space) but the target is a per-config setting, and this page isn't
  // config-scoped — see scopedAcceptTarget.
  targetSource: EffectiveAcceptTarget;
  minSamples: number;
  pairs: { total: number; shadow: number; generated: number; same: number; different: number };
  rows: LeaderboardRow[]; // sorted by recall@τ desc
};

// --- the pooled pair set ----------------------------------------------------

// Shadow verdicts are FREE — every judged row is reusable under any candidate
// model, since a verdict is a property of the (new_query, matched_query,
// served_answer) triple, not of the embedding model that surfaced it.
//
// KNOWN BIAS, and the reason shadow-only was rejected: a row only exists if it
// cleared shadowLogFloor UNDER THE MODEL IN USE AT CAPTURE TIME. A pair the
// capturing model scored 0.5 but a candidate scores 0.97 was never logged, so a
// candidate's false-positive rate is systematically UNDER-estimated here. The
// generated set (with hard negatives) covers that hole.
//
// Guard-blocked rows are INCLUDED: the guard is a separate lever, and excluding
// what it rejected would hide exactly the pairs it exists to catch.
async function shadowPairs(): Promise<SweepPair[]> {
  try {
    const rows = await sql<
      { new_query: string; matched_query: string; verdict: string; origin: string }[]
    >`
      select new_query, matched_query, verdict, origin
      from semantic_cache_shadow
      where verdict is not null
        and config_id in (select id from configs where user_id = ${activeUserId()})
    `;
    return rows.map((r) => ({
      textA: r.new_query,
      textB: r.matched_query,
      // A shadow verdict is already ANSWER-LEVEL ("would this stored answer
      // serve this new question"), which is the same target the generated
      // labels use — that's what makes the two poolable at all.
      label: r.verdict === "accept" ? ("same" as const) : ("different" as const),
      source: "shadow" as const,
      // A PROBE row is not traffic — it is a synthetic pair replayed through the
      // lookup path (0069). pooledPairs needs the distinction to resolve
      // collisions; nothing downstream of that reads it.
      origin: r.origin === "probe" ? ("probe" as const) : ("traffic" as const),
      difficulty: null,
    }));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

// The union of the two pair sources, deduped on the unordered text pair.
//
// THREE reads, not two: `quarantinedPairs` is separate because listPairs has
// already dropped those rows, and they are exactly the set a probe row must not
// be allowed to speak for — the F3 defect, where 146 of 147 collisions were a
// generated pair meeting ITSELF and the quarantine went inert for every pair
// that had been probed. The rule that fixes it is poolPairs in
// lib/rag/keyModelSweepCore.ts, which is where it is explained and tested.
export async function pooledPairs(
  opts: { includeQuarantined?: boolean } = {},
): Promise<SweepPair[]> {
  const [shadow, generated, quarantined] = await Promise.all([
    shadowPairs(),
    listPairs(opts),
    quarantinedPairs(),
  ]);
  // The rule itself is in the pure core, where a test can state the F3 defect as
  // an assertion rather than a paragraph (lib/rag/keyModelSweepCore.test.ts).
  // This function is now only the three reads it pools.
  return poolPairs(generated, quarantined, shadow);
}

// --- the sweep ---------------------------------------------------------------

// Score one candidate. Embeds every distinct text once (cached, so a re-run is
// nearly free), cosines each pair, then runs the same calibration the shadow
// judge uses — which is the point: τ is chosen by an identical rule for every
// model, so the recall numbers are directly comparable.
async function scoreModel(
  model: string,
  pairs: SweepPair[],
  target: number,
  shouldStop: ShouldStop,
): Promise<{
  threshold: number | null;
  recall: number | null;
  precision: number | null;
  aucValue: number | null;
  calibration: CalibrationResult;
  scored: { sim: number; label: PairLabel }[];
} | null> {
  const texts = [...new Set(pairs.flatMap((p) => [p.textA, p.textB]))];
  const vectors = new Map<string, number[]>();
  // ONE ROUND TRIP PER SLICE, not per text. This was a sequential per-text loop
  // through embedQueryCached, defended as being gentle on provider rate limits —
  // but that was never where the time went, and adding concurrency around it
  // changed nothing measurable: every store call in a request scope shares ONE
  // transaction on ONE connection (lib/db.ts), so the cache reads serialize
  // whatever the caller does. 324 texts cost 324 round trips at ~0.3s each.
  //
  // embedQueriesCached collapses a slice into one cache read, one batched
  // provider call for the misses, one write and one metering call.
  //
  // SLICED rather than one call for the whole set, because `shouldStop` can only
  // be checked between calls: a single bulk call would make the sweep
  // uncancellable for the length of a model. A slice is the cancellation
  // granularity, and it is also the unit a failure loses.
  const slice = config.semanticCache.keyModelSweep.embedSliceSize;
  for (let i = 0; i < texts.length; i += slice) {
    // A half-embedded model can't be scored — an incomplete text set would
    // silently grade this model on a different pair set than the others — so it
    // returns null and reports as unscored. The vectors it did buy are already
    // persisted.
    if (shouldStop()) return null;
    for (const [t, vec] of await embedQueriesCached(texts.slice(i, i + slice), model)) {
      vectors.set(t, vec);
    }
  }

  const scored = pairs.map((p) => ({
    sim: cosine(vectors.get(p.textA)!, vectors.get(p.textB)!),
    label: p.label,
  }));

  // The rest of this model's row is a pure function of `scored`, and it lives in
  // the core because the demo re-runs exactly it over the master's banked cosines
  // (phase 3 of docs/demo-cache-replay-plan.md). The embedding above is the half
  // a guest cannot afford; this half is the half they replay.
  return { ...scoreFromSims(scored, target, config.semanticCache.minCalibrationSamples), scored };
}

// Run the sweep over `candidates` (defaults to the configured list). Models
// whose provider has no key/weights are listed as unavailable rather than
// skipped silently. A single model's failure is captured on its own row — one
// unreachable provider must not lose the whole table.
export async function runKeyModelSweep(
  targetSource: EffectiveAcceptTarget,
  candidates: string[] = [...config.semanticCache.keyModelSweep.candidates],
  shouldStop: ShouldStop = NEVER_STOP,
  // `includeQuarantined` is an OFFLINE READ ONLY — the F3 before/after. No route
  // passes it; see listPairs. `observe` is offline-only for the same reason and
  // is documented on SweepObserver.
  opts: { includeQuarantined?: boolean; observe?: SweepObserver } = {},
): Promise<SweepResult> {
  const pairs = await pooledPairs(opts);
  // Before anything is scored, so that a CANCELLED sweep still tells the observer
  // which pairs the scores it did see were aligned to. The array and the per-model
  // `scored` arrays are parallel, and that is the whole contract.
  opts.observe?.onPairs?.(pairs);
  const counts = {
    total: pairs.length,
    shadow: pairs.filter((p) => p.source === "shadow").length,
    generated: pairs.filter((p) => p.source === "generated").length,
    same: pairs.filter((p) => p.label === "same").length,
    different: pairs.filter((p) => p.label === "different").length,
  };

  const rows: LeaderboardRow[] = [];
  const availability = await availableProviders();
  let cancelled = false;
  for (const model of candidates) {
    // A cancelled sweep still lists the models it never got to, for the same
    // reason unavailable ones are listed: an absent row reads as a bad score.
    if (cancelled || shouldStop()) {
      cancelled = true;
      const spec = EMBEDDING_MODELS[model];
      rows.push({
        model,
        space: spaceOf(model),
        dimension: spec?.dimension ?? 0,
        provider: spec?.provider ?? "unknown",
        available: false,
        reason: "not scored — sweep cancelled",
        threshold: null,
        recallAtThreshold: null,
        auc: null,
        precisionAtThreshold: null,
        pairsScored: 0,
        samePairs: counts.same,
        differentPairs: counts.different,
        calibration: null,
        error: null,
      });
      continue;
    }

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
      samePairs: counts.same,
      differentPairs: counts.different,
      calibration: null,
      error: null,
    };

    if (!spec) {
      rows.push({ ...base, available: false, reason: "not in EMBEDDING_MODELS" });
      continue;
    }
    if (!availability.has(spec.provider)) {
      rows.push({ ...base, available: false, reason: `${spec.provider} not enabled` });
      continue;
    }
    if (pairs.length === 0) {
      rows.push({ ...base, available: true, reason: "no pairs to score" });
      continue;
    }

    try {
      const s = await scoreModel(model, pairs, targetSource.target, shouldStop);
      if (!s) {
        cancelled = true;
        rows.push({
          ...base,
          available: false,
          reason: "not scored — sweep cancelled part-way through this model",
        });
        continue;
      }
      opts.observe?.onScored?.(model, s.scored);
      rows.push({
        ...base,
        available: true,
        reason: null,
        threshold: s.threshold,
        recallAtThreshold: s.recall,
        auc: s.aucValue,
        precisionAtThreshold: s.precision,
        pairsScored: s.scored.length,
        calibration: s.calibration,
      });
    } catch (err) {
      rows.push({ ...base, available: true, reason: null, error: (err as Error).message });
    }
  }

  // Recall@τ descending — the objective. Models that produced no τ (too few
  // samples, or no threshold clears the target) sort last: "couldn't be
  // measured" must never outrank a measured result.
  //
  // AUC breaks ties, which is also what orders the table in the case that
  // matters most in practice: a pair set on which NOTHING clears the precision
  // target leaves every recall null, and sorting by that alone would fall back
  // to candidate-list order and present it as a ranking.
  rows.sort(
    (a, b) =>
      (b.recallAtThreshold ?? -1) - (a.recallAtThreshold ?? -1) ||
      (b.auc ?? -1) - (a.auc ?? -1),
  );

  return {
    cancelled,
    target: targetSource.target,
    targetSource,
    minSamples: config.semanticCache.minCalibrationSamples,
    pairs: counts,
    rows,
  };
}
