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
// CANCELLATION. The full sweep is ~an hour of sequential embedding, so it takes a
// `shouldStop` flag like every other long job here (never a throw — see
// cancelRegistry). Stopping keeps everything already banked: embedQueryCached
// persists each vector as it goes, so a cancelled run still warms the cache and
// still returns the models it managed to score.
import { config } from "@/lib/config";
import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { NEVER_STOP, type ShouldStop } from "@/lib/http/cancelRegistry";
import { embedQueryCached } from "@/lib/rag/embedCache";
import { EMBEDDING_MODELS } from "@/lib/rag/embeddingModels";
import { availableProviders } from "@/lib/rag/providerAvailability";
import type { EffectiveAcceptTarget } from "@/lib/rag/semanticCache";
import {
  auc,
  calibrateFromJudged,
  cosine,
  spaceOf,
  type CalibrationResult,
} from "@/lib/rag/semanticCacheCore";
import {
  listPairs,
  quarantinedPairs,
  type PairDifficulty,
  type PairLabel,
} from "@/lib/rag/semanticCachePairs";

// A scored pair, source-tagged so the leaderboard can show the split — a row
// carried entirely by shadow rows means something different from one built on
// generated hard negatives, and the plan is explicit that neither source is
// sufficient alone.
export type SweepPair = {
  textA: string;
  textB: string;
  label: PairLabel;
  source: "shadow" | "generated";
  origin?: "traffic" | "probe"; // shadow only
  difficulty: PairDifficulty | null; // generated only
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

// The union, deduped on the unordered text pair so a question that appears in
// both sources is scored once.
//
// COLLISION RULE, and it is load-bearing — see F3. `traffic` shadow still wins:
// it is a verdict on a question a person actually asked, against a synthesized
// label. A `probe` shadow row does NOT, because a probe is not independent
// evidence: F1 and F2 replayed these very pair texts through the lookup path, so
// 146 of the 147 collisions here are a generated pair meeting ITSELF. Letting the
// replay win meant the pair table's audited verdict was discarded in favour of
// the label that replay was carrying — and since F3 wrote its verdicts to the
// pair table only, the quarantine was inert for every pair that had been probed:
// 8 rows F3 proved mislabelled re-entered the pool with the disproved label, and
// the generated set the sweep scored collapsed from 165 to 32.
//
// So a probe row that duplicates a generated pair is DROPPED, whether that pair
// survived the quarantine or was removed by it. `includeQuarantined` (the
// before/after read) puts the quarantined pairs back in the generated set, which
// suppresses the same probes for the same reason — the comparison is between two
// label sets, not between two dedupe rules.
export async function pooledPairs(
  opts: { includeQuarantined?: boolean } = {},
): Promise<SweepPair[]> {
  const [shadow, generated, quarantined] = await Promise.all([
    shadowPairs(),
    listPairs(opts),
    quarantinedPairs(),
  ]);
  const byKey = new Map<string, SweepPair>();
  // NUL as the separator, written as an ESCAPE rather than a literal control
  // character: a raw \x00 in the source makes git treat this whole file as
  // binary, so every change to it lands as an unreviewable "Bin" diff. Behaviour
  // is identical -- NUL cannot occur in question text, so it can't forge a key.
  const key = (a: string, b: string) =>
    a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  for (const p of generated) {
    byKey.set(key(p.textA, p.textB), {
      textA: p.textA,
      textB: p.textB,
      label: p.label,
      source: "generated",
      difficulty: p.difficulty,
    });
  }
  // Every pair the generator produced, INCLUDING the quarantined ones — the set a
  // probe row is not allowed to speak for. Quarantined keys have to be listed
  // separately because listPairs has already dropped them.
  const generatedKeys = new Set([
    ...generated.map((p) => key(p.textA, p.textB)),
    ...quarantined.map((p) => key(p.textA, p.textB)),
  ]);
  for (const p of shadow) {
    const k = key(p.textA, p.textB);
    if (p.origin === "probe" && generatedKeys.has(k)) continue;
    byKey.set(k, p);
  }
  return [...byKey.values()].filter((p) => p.textA !== p.textB);
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
  // Sequential: a sweep is a background action with no latency budget, and one
  // request at a time is what provider rate limits like.
  for (const t of texts) {
    // Checked BETWEEN embeddings, so cancelling lands within one provider call
    // rather than at the end of the model. A half-embedded model can't be
    // scored — an incomplete text set would silently grade this model on a
    // different pair set than the others — so it returns null and reports as
    // unscored. The vectors it did buy are already persisted.
    if (shouldStop()) return null;
    vectors.set(t, await embedQueryCached(t, model));
  }

  const scored = pairs.map((p) => ({
    sim: cosine(vectors.get(p.textA)!, vectors.get(p.textB)!),
    label: p.label,
  }));

  // calibrateFromJudged speaks accept/reject; 'same' IS 'accept' here — both
  // mean "one answer serves both", which is why the pair labels were defined
  // answer-level in the first place.
  const calibration = calibrateFromJudged(
    scored.map((s) => ({ sim: s.sim, verdict: s.label === "same" ? "accept" : "reject" })),
    target,
    config.semanticCache.minCalibrationSamples,
  );
  return {
    threshold: calibration.recommended,
    recall: calibration.coverageAtRecommended,
    // Straight off the calibration now. This used to re-find the curve point by
    // `sim === at`, which returns the FIRST point carrying that sim — but τ is
    // chosen at the LAST one (the tie boundary), and the two have different n
    // and so different rates whenever sims tie. Serving `sim >= τ` admits the
    // whole tie group, so the boundary's rate is the one that describes it.
    precision: calibration.precisionAtRecommended,
    aucValue: auc(scored),
    calibration,
    scored,
  };
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
  // passes it; see listPairs.
  opts: { includeQuarantined?: boolean } = {},
): Promise<SweepResult> {
  const pairs = await pooledPairs(opts);
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
