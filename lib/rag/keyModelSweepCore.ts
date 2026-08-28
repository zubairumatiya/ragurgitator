// THE KEY-MODEL SWEEP'S PURE HALF: how the pair sources are POOLED, and what a
// leaderboard row is once the cosines exist. The first has already been got wrong
// once (F3, below); the second is the arithmetic the demo replays.
//
// Database-free on purpose, like semanticCacheCore.ts and probeReplayCore.ts —
// semanticCacheCore is its one import and is the same kind of module. Both
// decisions here are properties of a few lists rather than of a database, which
// is what lets a test state the F3 defect as an assertion instead of a paragraph.

import {
  auc,
  calibrateFromJudged,
  type CalibrationResult,
} from "@/lib/rag/semanticCacheCore";

// The label and difficulty vocabularies, restated rather than imported so this
// file stays free of anything that touches a database. keyModelSweep.ts is where
// these meet the real ones, and the compiler checks they agree there.
export type PairLabelLike = "same" | "different";
export type PairDifficultyLike = "paraphrase" | "hard-negative";

// A scored pair, source-tagged so the leaderboard can show the split — a row
// carried entirely by shadow rows means something different from one built on
// generated hard negatives, and neither source is sufficient alone.
export type SweepPair = {
  textA: string;
  textB: string;
  label: PairLabelLike;
  source: "shadow" | "generated";
  origin?: "traffic" | "probe"; // shadow only
  difficulty: PairDifficultyLike | null; // generated only
};

export type GeneratedPair = {
  textA: string;
  textB: string;
  label: PairLabelLike;
  difficulty: PairDifficultyLike | null;
};

export type TextPair = { textA: string; textB: string };

// Unordered, because a pair is unordered: insertPairs canonicalises by hash, and
// a shadow row's (new_query, matched_query) can arrive in either orientation.
//
// NUL as the separator, written as an ESCAPE rather than a literal control
// character: a raw \x00 in the source makes git treat the whole file as binary,
// so every change lands as an unreviewable "Bin" diff. Behaviour is identical —
// NUL cannot occur in question text, so it cannot forge a key.
export const pairKey = (a: string, b: string): string =>
  a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;

// The union of the generated pair set and the judged shadow log, deduped on the
// unordered text pair so a question appearing in both sources is scored once.
//
// THE COLLISION RULE IS LOAD-BEARING — see F3. A `traffic` shadow row still wins
// over a generated pair: it is a verdict on a question a person actually asked,
// against a synthesized label. A `probe` shadow row does NOT, because a probe is
// not independent evidence: F1, F2 and now the probe-replay job push these very
// pair texts back through the lookup path, so a probe/generated collision is
// overwhelmingly a generated pair meeting ITSELF.
//
// Letting the replay win is exactly the bug F3 found: the pair table's audited
// verdict was discarded in favour of the label the replay carried, and since F3
// wrote its verdicts to the pair table only, the quarantine went INERT for every
// pair that had been probed — 8 rows F3 proved mislabelled re-entered the pool
// with the disproved label, and the generated set collapsed from 165 to 32.
//
// So a probe row that duplicates a generated pair is DROPPED, whether that pair
// survived the quarantine or was removed by it — which is why `quarantined` is a
// separate argument at all: listPairs has already filtered those out, and a probe
// speaking for a pair the audit disproved is the precise shape of the defect.
// `includeQuarantined` (the before/after read) puts them back into `generated`,
// which suppresses the same probes for the same reason: that comparison is
// between two label sets, not between two dedupe rules.
export function poolPairs(
  generated: GeneratedPair[],
  quarantined: TextPair[],
  shadow: SweepPair[],
): SweepPair[] {
  const byKey = new Map<string, SweepPair>();
  for (const p of generated) {
    byKey.set(pairKey(p.textA, p.textB), {
      textA: p.textA,
      textB: p.textB,
      label: p.label,
      source: "generated",
      difficulty: p.difficulty,
    });
  }
  // Every pair the generator produced, INCLUDING the quarantined ones — the set a
  // probe row is not allowed to speak for.
  const generatedKeys = new Set([
    ...generated.map((p) => pairKey(p.textA, p.textB)),
    ...quarantined.map((p) => pairKey(p.textA, p.textB)),
  ]);
  for (const p of shadow) {
    const k = pairKey(p.textA, p.textB);
    if (p.origin === "probe" && generatedKeys.has(k)) continue;
    byKey.set(k, p);
  }
  // A pair of identical texts scores nothing and calibrates nothing.
  return [...byKey.values()].filter((p) => p.textA !== p.textB);
}

// EVERY NUMBER ON A LEADERBOARD ROW, FROM THE COSINES ALONE — extracted for
// phase 3 of docs/demo-cache-replay-plan.md.
//
// This was the tail of scoreModel, which is where it still runs for a real
// account. It is here because the demo replays it: a guest holds the master's
// banked cosines and nothing else, and re-running THIS function over the first
// `n` of them is what makes their leaderboard byte-identical to a real sweep at
// that size. Two copies of this arithmetic would be two answers to the same
// question, and the whole claim of the replay is that there is one.
//
// Pure, and pure of the embedding step in particular: `scored` is what the
// vectors were FOR, so everything downstream of them lives here and the paid
// half stays in keyModelSweep.
export function scoreFromSims(
  scored: { sim: number; label: PairLabelLike }[],
  target: number,
  minSamples: number,
): {
  threshold: number | null;
  recall: number | null;
  precision: number | null;
  aucValue: number | null;
  calibration: CalibrationResult;
} {
  // calibrateFromJudged speaks accept/reject; 'same' IS 'accept' here — both mean
  // "one answer serves both", which is why the pair labels were defined
  // answer-level in the first place.
  const calibration = calibrateFromJudged(
    scored.map((s) => ({ sim: s.sim, verdict: s.label === "same" ? "accept" : "reject" })),
    target,
    minSamples,
  );
  return {
    threshold: calibration.recommended,
    recall: calibration.coverageAtRecommended,
    // Straight off the calibration. This used to re-find the curve point by
    // `sim === at`, which returns the FIRST point carrying that sim — but τ is
    // chosen at the LAST one (the tie boundary), and the two have different n and
    // so different rates whenever sims tie. Serving `sim >= τ` admits the whole
    // tie group, so the boundary's rate is the one that describes it.
    precision: calibration.precisionAtRecommended,
    aucValue: auc(scored),
    calibration,
  };
}
