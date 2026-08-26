// Contract tests for the semantic-cache CORE — the decisions that make a hit
// correct: nearest-match selection, the threshold gate, per-space threshold
// keying, and fingerprint validity. Imports only semanticCacheCore (which is
// DB-free), so it runs without a DATABASE_URL, exactly like evalMetrics.test.ts.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answerFingerprint,
  auc,
  bestMatch,
  calibrateFromJudged,
  collisionFloor,
  cosine,
  entityGuardPasses,
  entityOrderPasses,
  entityTokens,
  fingerprintFrom,
  isHit,
  selectFromCurve,
  spaceOf,
} from "./semanticCacheCore";

test("cosine: identical vectors are 1, orthogonal are 0, zero-vector is 0", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  // Magnitude doesn't matter — direction does.
  assert.ok(Math.abs(cosine([2, 0], [5, 0]) - 1) < 1e-12);
});

test("bestMatch: returns null when there are no candidates", () => {
  assert.equal(bestMatch([1, 0], []), null);
});

test("bestMatch: picks the highest-cosine entry and reports its sim", () => {
  const q = [1, 0];
  const entries = [
    { vector: [0, 1], value: "orthogonal" },
    { vector: [0.9, 0.1], value: "close" },
    { vector: [0.6, 0.8], value: "middling" },
  ];
  const best = bestMatch(q, entries);
  assert.ok(best !== null);
  assert.equal(best.value, "close");
  assert.ok(best.sim > 0.9 && best.sim < 1);
});

test("bestMatch: an exact-repeat query matches at sim ≈ 1", () => {
  const q = [0.3, 0.4, 0.5];
  const best = bestMatch(q, [{ vector: [0.3, 0.4, 0.5], value: "same" }]);
  assert.ok(best !== null);
  assert.ok(Math.abs(best.sim - 1) < 1e-12);
});

test("isHit: gate is inclusive at the threshold", () => {
  assert.equal(isHit(0.95, 0.95), true); // boundary hits
  assert.equal(isHit(0.9499, 0.95), false);
  assert.equal(isHit(0.99, 0.95), true);
});

test("spaceOf: same-space models collapse to one threshold key; others are self", () => {
  // voyage-4 family shares vectorSpace "voyage-4" (see embeddingModels.ts).
  assert.equal(spaceOf("voyage-4-lite"), "voyage-4");
  assert.equal(spaceOf("voyage-4-large"), "voyage-4");
  assert.equal(spaceOf("voyage-4-lite"), spaceOf("voyage-4"));
  // A model without a vectorSpace tag is its own space.
  assert.equal(spaceOf("voyage-code-3"), "voyage-code-3");
  // Different providers are never the same space.
  assert.notEqual(spaceOf("voyage-4-lite"), spaceOf("text-embedding-3-large"));
  // An unknown model id falls back to itself (never throws).
  assert.equal(spaceOf("made-up-model"), "made-up-model");
});

// --- entity/number guard (Phase 0) -----------------------------------------

test("entityTokens: numerals, years, percentages and currency are captured", () => {
  const t = entityTokens("Was 2023 revenue $1.2M, up 40% from 4.5?");
  assert.ok(t.has("n:2023"));
  assert.ok(t.has("n:1.2m")); // currency sign stripped, scale suffix kept
  assert.ok(t.has("n:40%")); // % kept — "40%" and "40" are different facts
  assert.ok(t.has("n:4.5"));
});

test("entityTokens: thousands separators normalize to the bare number", () => {
  assert.deepEqual(entityTokens("is the cap 1,200"), entityTokens("is the cap 1200"));
});

test("entityTokens: ALLCAPS acronyms of length ≥ 2, and quoted spans", () => {
  const t = entityTokens('What does the PTO policy say about "carry over" days? I asked.');
  assert.ok(t.has("a:pto"));
  assert.ok(t.has("q:carry over"));
  // Single letters aren't acronyms, and ordinary Capitalised words aren't either.
  assert.ok(!t.has("a:i"));
  assert.ok(!t.has("a:what"));
});

test("entityTokens: an ALL-CAPS question yields no acronym tokens", () => {
  // Every word looks like an acronym there, so extraction is skipped rather
  // than manufacturing tokens that would block everything.
  const t = entityTokens("WHAT IS THE PTO POLICY");
  assert.ok([...t].every((x) => !x.startsWith("a:")));
});

test("entityGuardPasses: the year case the guard exists for is blocked", () => {
  assert.equal(
    entityGuardPasses("what was 2023 revenue", "what was 2024 revenue"),
    false,
  );
});

test("entityGuardPasses: pure paraphrase with no entity tokens passes", () => {
  assert.equal(
    entityGuardPasses("how do I request time off", "what's the process to request time off"),
    true,
  );
});

test("entityGuardPasses: same numbers, different phrasing passes", () => {
  assert.equal(
    entityGuardPasses("what was 2023 revenue", "tell me the revenue for 2023"),
    true,
  );
});

test("entityGuardPasses: a number present on only one side blocks", () => {
  // Deliberately conservative — "top 5" may or may not be the same question as
  // "the benefits", and the guard's worst case is lost savings, not a wrong
  // answer. Phase 2 measures what this costs.
  assert.equal(
    entityGuardPasses("what are the top 5 benefits", "what are the benefits"),
    false,
  );
});

test("entityGuardPasses: acronym CASING is not a factual difference", () => {
  assert.equal(
    entityGuardPasses("what is the PTO policy", "what is the pto policy"),
    true,
  );
});

test("entityGuardPasses: genuinely different acronyms still block", () => {
  assert.equal(entityGuardPasses("what is the PTO policy", "what is the FMLA policy"), false);
});

test("entityGuardPasses: differing quoted spans block", () => {
  assert.equal(
    entityGuardPasses('what does "gross misconduct" mean', 'what does "gross negligence" mean'),
    false,
  );
});

test("entityGuardPasses: apostrophes are not read as quoted spans", () => {
  assert.equal(
    entityGuardPasses("what's the company's policy", "what is the company policy"),
    true,
  );
});

test("entityGuardPasses: symmetric in its arguments", () => {
  const a = "what was 2023 revenue";
  const b = "what was revenue";
  assert.equal(entityGuardPasses(a, b), entityGuardPasses(b, a));
});

// --- the validity key: what invalidates a cached answer, and what doesn't -----
//
// The whole point of the user-scoping change (docs/semantic-cache-user-scope-
// plan.md). answerFingerprint takes ONLY the document set and saver mode, so
// "changing topK no longer nukes the cache" is enforced by the signature rather
// than by a test — what needs asserting is the other half: that the two things
// still in the key really do separate buckets.

test("answerFingerprint: the same documents and saver mode share one bucket", () => {
  // Two configs differing on every retrieval knob there is — chunk size, topK,
  // fusion pool, even the retrieval embedding model — reach the SAME key,
  // because none of them can reach this function. Ask under one, hit under the
  // other. That is the feature.
  assert.equal(
    answerFingerprint({ cascadeEnabled: false, documents: "docs-abc" }),
    answerFingerprint({ cascadeEnabled: false, documents: "docs-abc" }),
  );
});

test("answerFingerprint: saver mode separates buckets", () => {
  // The correctness case. With saver mode ON the answer comes from the cheap
  // model, so a saver-mode config's answer must never be served to one running
  // the strong model — and llm_model, being identical for both, cannot tell them
  // apart. Under the old config_id scoping this was hidden; under user scoping
  // it is live.
  assert.notEqual(
    answerFingerprint({ cascadeEnabled: true, documents: "docs-abc" }),
    answerFingerprint({ cascadeEnabled: false, documents: "docs-abc" }),
  );
});

test("answerFingerprint: a different document set separates buckets", () => {
  assert.notEqual(
    answerFingerprint({ cascadeEnabled: false, documents: "docs-abc" }),
    answerFingerprint({ cascadeEnabled: false, documents: "docs-xyz" }),
  );
});

test("fingerprintFrom: deterministic for identical inputs", () => {
  const a = fingerprintFrom(["sc-v1", "voyage-4-lite", 512, 50, 5, null, "claude", "baseline", "c:10"]);
  const b = fingerprintFrom(["sc-v1", "voyage-4-lite", 512, 50, 5, null, "claude", "baseline", "c:10"]);
  assert.equal(a, b);
});

test("fingerprintFrom: any changed part flips the fingerprint", () => {
  const base = fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude", "baseline", "c:10"]);
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 256, 50, 5, "claude", "baseline", "c:10"])); // chunk size
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude-2", "baseline", "c:10"])); // llm
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude", "override-x", "c:10"])); // overrides
  assert.notEqual(base, fingerprintFrom(["voyage-4-lite", 512, 50, 5, "claude", "baseline", "c:11"])); // corpus
});

test("fingerprintFrom: null is distinct from the strings that could collide with it", () => {
  const withNull = fingerprintFrom(["a", null, "b"]);
  assert.notEqual(withNull, fingerprintFrom(["a", "null", "b"]));
  assert.notEqual(withNull, fingerprintFrom(["a", "", "b"]));
  assert.notEqual(withNull, fingerprintFrom(["a", "∅", "b"]));
});

test("fingerprintFrom: field boundaries can't be forged by concatenation", () => {
  // Without a delimiter, ["ab","c"] and ["a","bc"] would collide; the separator
  // keeps a value's content from bleeding into the next field.
  assert.notEqual(fingerprintFrom(["ab", "c"]), fingerprintFrom(["a", "bc"]));
});

// --- Phase 2 calibration: collision floor -----------------------------------

test("collisionFloor: floor is the max cosine among DISTINCT-chunk pairs", () => {
  // q1,q2 → chunk A (same-answer, near-identical); q3 → chunk B, far from both.
  const vectors = new Map<string, number[]>([
    ["q1", [1, 0]],
    ["q2", [0.99, 0.14]], // very close to q1 (cos ≈ 0.99)
    ["q3", [0, 1]], // distinct question, far from q1/q2 (cos ≈ 0 / 0.14)
  ]);
  const labels = [
    { questionId: "q1", sourceChunkId: "A" },
    { questionId: "q2", sourceChunkId: "A" },
    { questionId: "q3", sourceChunkId: "B" },
  ];
  const r = collisionFloor(labels, vectors, 0.01);
  assert.equal(r.distinctPairs, 2); // q1-q3, q2-q3
  assert.equal(r.sameAnswerPairs, 1); // q1-q2
  // A safe band exists: the floor (closest distinct pair) sits well below the
  // same-answer pair, so recommended lands just above the floor and would catch
  // q1↔q2 but never q*↔q3.
  assert.ok(r.floor !== null && r.floor! < 0.5);
  assert.ok(r.sameAnswerMin !== null && r.sameAnswerMin! > 0.95);
  assert.equal(r.overlap, false);
  assert.ok(r.recommended !== null && r.recommended > r.floor!);
  assert.ok(r.recommended! <= r.sameAnswerMin!);
});

test("collisionFloor: reports overlap when a distinct pair is closer than a same-answer pair", () => {
  const vectors = new Map<string, number[]>([
    ["q1", [1, 0]],
    ["q2", [0.6, 0.8]], // same chunk as q1 but far apart
    ["q3", [0.99, 0.14]], // different chunk yet very close to q1
  ]);
  const labels = [
    { questionId: "q1", sourceChunkId: "A" },
    { questionId: "q2", sourceChunkId: "A" },
    { questionId: "q3", sourceChunkId: "B" },
  ];
  const r = collisionFloor(labels, vectors, 0.01);
  assert.equal(r.overlap, true); // floor ≥ sameAnswerMin → no fully-safe band
  assert.ok(r.recommended !== null && r.recommended > r.floor!); // stays above the floor
});

test("collisionFloor: questions without a cached vector are skipped", () => {
  const vectors = new Map<string, number[]>([["q1", [1, 0]]]);
  const labels = [
    { questionId: "q1", sourceChunkId: "A" },
    { questionId: "q2", sourceChunkId: "B" }, // no vector → dropped
  ];
  const r = collisionFloor(labels, vectors, 0.01);
  assert.equal(r.questionsUsed, 1);
  assert.equal(r.distinctPairs, 0);
  assert.equal(r.floor, null);
  assert.equal(r.recommended, null); // nothing to calibrate against
});

// --- Phase 2 calibration: precision-at-threshold sweep ----------------------

test("calibrateFromJudged: recommends the lowest τ whose served set stays ≥ target", () => {
  // High sims accept, low sims reject. With target 1.0 and minSamples 1, the
  // lowest all-accept prefix boundary is 0.90.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.85, verdict: "reject" as const },
    { sim: 0.82, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 1.0, 1);
  assert.equal(r.recommended, 0.9);
  assert.equal(r.totalJudged, 5);
  assert.ok(Math.abs(r.overallAcceptRate! - 3 / 5) < 1e-9);
});

test("calibrateFromJudged: tolerates a dip that recovers (aggregate guarantee)", () => {
  // One reject at 0.90 drops the prefix rate to 0.75, but two accepts below pull
  // the aggregate over [0.80,1] back to 4/5 = 0.80 ≥ target.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
    { sim: 0.85, verdict: "accept" as const },
    { sim: 0.8, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 0.8, 1);
  assert.equal(r.recommended, 0.8); // most inclusive prefix still ≥ 0.8
});

test("calibrateFromJudged: a tie group is judged whole, not part-way through", () => {
  // Three events share sim 0.90 and straddle the target crossing: accept,
  // accept, reject. Mid-group the prefix is 4/4 = 1.0 ≥ target, but serving
  // `sim >= 0.90` also admits the reject, giving 4/5 = 0.80 < target. τ must
  // therefore fall back to 0.95, above the tie group entirely.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 1.0, 1);
  assert.equal(r.recommended, 0.95);
});

test("calibrateFromJudged: a tie group that clears the target as a whole is usable", () => {
  // Same tie group, but the aggregate over [0.90,1] is 4/5 = 0.80 ≥ target, so
  // the boundary sim IS a valid τ — folding must not reject it outright.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 0.8, 1);
  assert.equal(r.recommended, 0.9);
});

test("calibrateFromJudged: no recommendation below the minimum sample size", () => {
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 0.9, 20);
  assert.equal(r.recommended, null);
});

// --- attainability: WHY there is no τ ---------------------------------------
// A bare `recommended: null` reads as "this model is bad" when it usually means
// "the target can't be reached on a set this size". keyModelSweep ranks on
// recall@τ and silently falls back to AUC when every recall is null, so the
// distinction has to be reportable rather than inferred.

test("attainability: a recommendation leaves nothing to explain", () => {
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    // Below every candidate τ, and present only so the sample carries both
    // classes — an all-accept set is now refused outright as one-class.
    { sim: 0.5, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 0.9, 1);
  assert.equal(r.recommended, 0.9);
  assert.equal(r.attainability.blocker, null);
  // requiredN is only for a FAILED prefix; a clean best prefix has no reject
  // count to forgive, so there is no size to demand.
  assert.equal(r.attainability.requiredN, null);
  assert.equal(r.attainability.rejectsInBest, 0);
});

test("attainability: nothing judged is distinguished from judged-but-short", () => {
  const empty = calibrateFromJudged([], 0.99, 20);
  assert.equal(empty.attainability.blocker, "no-events");
  assert.equal(empty.attainability.bestRate, null);
  assert.equal(empty.attainability.bestRateAt, null);

  // Judged, but no prefix ever reaches minSamples — so no prefix was ever
  // ELIGIBLE. That's a "go label more", not a "the target is too strict".
  const short = calibrateFromJudged(
    [
      { sim: 0.98, verdict: "accept" as const },
      { sim: 0.95, verdict: "accept" as const },
    ],
    0.99,
    20,
  );
  assert.equal(short.attainability.blocker, "below-min-samples");
  assert.equal(short.attainability.bestRate, null);
  assert.equal(short.attainability.requiredN, null);
});

test("attainability: 0.99 on a small set reports the n it would need", () => {
  // 20 events, one reject: the best eligible prefix is the whole set at 19/20 =
  // 0.95. To clear 0.99 while still carrying that 1 reject the prefix would have
  // to hold n ≥ 1/(1−0.99) = 100 events. This is the exact case that makes 0.99
  // mean "zero false positives" on a small judged set.
  const events = [
    ...Array.from({ length: 19 }, (_, i) => ({
      sim: 0.99 - i * 0.001,
      verdict: "accept" as const,
    })),
    { sim: 0.9, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 0.99, 20);
  assert.equal(r.recommended, null);
  assert.equal(r.attainability.blocker, "target-unreachable");
  assert.ok(Math.abs(r.attainability.bestRate! - 0.95) < 1e-9);
  assert.equal(r.attainability.bestRateAt!.n, 20);
  assert.equal(r.attainability.rejectsInBest, 1);
  assert.equal(r.attainability.requiredN, 100);

  // Same events, looser target: 0.95 is reachable, so the blocker clears and the
  // recommendation appears. This is the knob the per-config override turns.
  const looser = calibrateFromJudged(events, 0.95, 20);
  assert.equal(looser.recommended, 0.9);
  assert.equal(looser.attainability.blocker, null);
});

test("attainability: requiredN scales with the reject count, not the set size", () => {
  // Three rejects at 0.99 → n ≥ 3/(1−0.99) = 300, regardless of how few events
  // exist. The number answers "how big would this have to get", so it must not
  // be capped at what's already there.
  const events = [
    ...Array.from({ length: 17 }, (_, i) => ({
      sim: 0.99 - i * 0.001,
      verdict: "accept" as const,
    })),
    { sim: 0.9, verdict: "reject" as const },
    { sim: 0.89, verdict: "reject" as const },
    { sim: 0.88, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 0.99, 20);
  assert.equal(r.attainability.blocker, "target-unreachable");
  assert.equal(r.attainability.rejectsInBest, 3);
  assert.equal(r.attainability.requiredN, 300);
});

test("attainability: requiredN is the n that actually passes, not ceil(r/(1−t))", () => {
  // The algebra and IEEE disagree at these targets: `1 - 0.9` is
  // 0.09999999999999998, so ceil(1/(1−0.9)) is 11 — while 10 events with 1
  // reject score 9/10 = 0.9 and clear the target. The panel renders this as
  // "judge this many more", so an event of slop is a wrong instruction.
  const oneReject = [
    { sim: 0.99, verdict: "accept" as const },
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.97, verdict: "accept" as const },
    { sim: 0.96, verdict: "accept" as const },
    { sim: 0.5, verdict: "reject" as const },
  ];
  const at90 = calibrateFromJudged(oneReject, 0.9, 5);
  assert.equal(at90.attainability.blocker, "target-unreachable");
  assert.equal(at90.attainability.rejectsInBest, 1);
  assert.equal(at90.attainability.requiredN, 10);
  // And the number it names has to pass the sweep's OWN comparison, which is
  // the property the fix is really about.
  const n = at90.attainability.requiredN!;
  assert.ok((n - 1) / n >= 0.9);

  // 0.8 slips the same way (ceil says 6, 4/5 = 0.8 clears it).
  const at80 = calibrateFromJudged(oneReject.slice(0, 2).concat(oneReject[4]), 0.8, 3);
  assert.equal(at80.attainability.rejectsInBest, 1);
  assert.equal(at80.attainability.requiredN, 5);
});

test("attainability: target 1.0 states no requiredN — no prefix forgives a reject", () => {
  // At target 1 the inversion n ≥ r/(1−target) divides by zero. Infinity would be
  // arithmetically true but useless to render, so it's reported as unstatable.
  const events = [
    ...Array.from({ length: 19 }, (_, i) => ({
      sim: 0.99 - i * 0.001,
      verdict: "accept" as const,
    })),
    { sim: 0.9, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 1, 20);
  assert.equal(r.recommended, null);
  assert.equal(r.attainability.blocker, "target-unreachable");
  assert.equal(r.attainability.rejectsInBest, 1);
  assert.equal(r.attainability.requiredN, null);
});

test("attainability: the best prefix is a prefix the sweep would have considered", () => {
  // A mid-tie-group prefix can show a flattering rate the sweep can never serve
  // (see the tie-boundary tests above). bestRate must use the same eligibility
  // predicate, or the explanation would cite an unservable number: here the
  // three 0.90 events straddle the crossing, so the eligible boundaries are
  // n=1 (1/1) and n=4 (3/4) — never the 2/2 or 3/3 mid-group prefixes at a sim
  // whose group also holds a reject.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 0.99, 2);
  assert.equal(r.recommended, null);
  assert.equal(r.attainability.blocker, "target-unreachable");
  // n=4 (3/4 = 0.75) is the only eligible boundary at minSamples 2 — the n=1
  // boundary is below it, and no boundary sits mid-group.
  assert.equal(r.attainability.bestRateAt!.n, 4);
  assert.ok(Math.abs(r.attainability.bestRate! - 0.75) < 1e-9);
});

// A sample with only one class cannot locate a boundary: precision is 1 at every
// cut point, so the "recommended" τ is just the lowest sim observed. This account's
// real traffic is exactly that shape (91 accepts, 0 rejects) and it recommends 0.81
// against a live 0.95 — a three-fold loosening argued from a sample containing no
// evidence of where matches fail.
test("attainability: an all-accept sample yields no τ at all", () => {
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.81, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 0.9, 1);
  assert.equal(r.recommended, null);
  assert.equal(r.attainability.blocker, "one-class-sample");
  // Nothing survives that would let a caller reconstruct the suppressed τ.
  assert.equal(r.precisionAtRecommended, null);
  assert.equal(r.coverageAtRecommended, null);
  // The observed operating point is still reported — the panel shows it, it just
  // may not call it a recommendation.
  assert.equal(r.attainability.bestRate, 1);
  assert.equal(r.attainability.bestRateAt!.sim, 0.98);
});

test("attainability: one-class does not preempt below-min-samples", () => {
  // Also all-accept, but no prefix was ever ELIGIBLE, so the honest complaint is
  // still the size of the sample. Precedence matters: "judge more events" and
  // "judge something that fails" are different instructions.
  const r = calibrateFromJudged(
    [
      { sim: 0.98, verdict: "accept" as const },
      { sim: 0.95, verdict: "accept" as const },
    ],
    0.9,
    20,
  );
  assert.equal(r.recommended, null);
  assert.equal(r.attainability.blocker, "below-min-samples");
});

test("attainability: an all-reject sample keeps saying target-unreachable", () => {
  // One-class too, but no τ was ever on offer, and the reach of the target is the
  // more useful thing to say about it. This path is deliberately untouched.
  const r = calibrateFromJudged(
    [
      { sim: 0.98, verdict: "reject" as const },
      { sim: 0.95, verdict: "reject" as const },
    ],
    0.9,
    1,
  );
  assert.equal(r.recommended, null);
  assert.equal(r.attainability.blocker, "target-unreachable");
});

// --- recall (coverage) — the half the sweep never computed -------------------

test("calibrateFromJudged: coverage is the share of ALL accepts the prefix serves", () => {
  // Four accepts total. At sim 0.95 the prefix holds two of them.
  const events = [
    { sim: 0.99, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.85, verdict: "accept" as const },
    // Sits below τ, so it changes none of the arithmetic this test pins — it is
    // here only to keep the sample two-class. Without it there is no τ at all
    // and the coverage this exists to check has nowhere to be measured.
    { sim: 0.6, verdict: "reject" as const },
  ];
  const r = calibrateFromJudged(events, 1.0, 1);
  assert.equal(r.totalAccepts, 4);
  assert.equal(r.curve[1].coverageAtOrAbove, 0.5);
  // Precision holds at 1.0 down to 0.85, so τ walks there and recall reaches 1
  // — every accept is served, with no reject admitted alongside them.
  assert.equal(r.recommended, 0.85);
  assert.equal(r.coverageAtRecommended, 1);
});

test("calibrateFromJudged: coverageAtRecommended is τ's recall, not the tightest prefix's", () => {
  // The reject at 0.90 caps τ at 0.95, which serves 2 of the 3 accepts. The
  // number that matters is the one τ achieves — 2/3 — not the 1/3 at the top of
  // the curve, which is what a naive "first qualifying point" read would give.
  const events = [
    { sim: 0.99, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
    { sim: 0.85, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 1.0, 1);
  assert.equal(r.recommended, 0.95);
  assert.equal(r.totalAccepts, 3);
  assert.equal(r.coverageAtRecommended, 2 / 3);
});

test("calibrateFromJudged: no recommendation means no recall to report", () => {
  const r = calibrateFromJudged([{ sim: 0.9, verdict: "reject" as const }], 0.99, 1);
  assert.equal(r.recommended, null);
  assert.equal(r.coverageAtRecommended, null);
  assert.equal(r.totalAccepts, 0);
});

// --- Phase 4: the curve carries everything the choice needs ------------------
//
// The panel re-derives τ from `calibration.curve` at a target the server never
// saw. That is only sound if the curve is a LOSSLESS input to the choice — so
// these pin the property the split depends on: selecting from the curve and
// calibrating from the events it came from must agree, at any target.

test("selectFromCurve: matches calibrateFromJudged on the curve it produced", () => {
  const events = [
    { sim: 0.99, verdict: "accept" as const },
    { sim: 0.97, verdict: "accept" as const },
    { sim: 0.95, verdict: "reject" as const },
    { sim: 0.93, verdict: "accept" as const },
    { sim: 0.91, verdict: "accept" as const },
    { sim: 0.88, verdict: "reject" as const },
    { sim: 0.85, verdict: "accept" as const },
    { sim: 0.8, verdict: "reject" as const },
  ];
  // Swept across the whole range, because the client's slider is exactly this:
  // one curve, re-read at a target the server never computed.
  for (const target of [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 1.0]) {
    const full = calibrateFromJudged(events, target, 2);
    const fromCurve = selectFromCurve(full.curve, target, 2);
    assert.deepEqual(
      {
        recommended: fromCurve.recommended,
        coverage: fromCurve.coverageAtRecommended,
        precision: fromCurve.precisionAtRecommended,
        attainability: fromCurve.attainability,
      },
      {
        recommended: full.recommended,
        coverage: full.coverageAtRecommended,
        precision: full.precisionAtRecommended,
        attainability: full.attainability,
      },
      `disagreed at target ${target}`,
    );
  }
});

test("selectFromCurve: the tie-boundary rule survives the round trip", () => {
  // The folding case, re-derived from the curve alone. The curve records one
  // point per event, so a tie group is three points sharing a sim — and the
  // boundary has to be found by looking at the NEIGHBOUR, since the raw verdicts
  // are gone by then. Mid-group the prefix reads 4/4, but serving `sim >= 0.90`
  // admits the reject too, so τ must fall back above the group.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
  ];
  const { curve } = calibrateFromJudged(events, 1.0, 1);
  assert.equal(selectFromCurve(curve, 1.0, 1).recommended, 0.95);
});

test("selectFromCurve: precision at τ is the tie boundary's, not the group's first point", () => {
  // Three events tie at 0.90 and the group as a whole clears 0.75 (4/5 = 0.80),
  // so τ = 0.90. Precision must describe what `sim >= 0.90` SERVES — all five
  // events, 0.80 — not the 3/3 = 1.0 reading at the group's first point, which
  // is what a `curve.find(c => c.sim === τ)` lookup returns.
  const events = [
    { sim: 0.98, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.9, verdict: "accept" as const },
    { sim: 0.9, verdict: "reject" as const },
    { sim: 0.9, verdict: "accept" as const },
  ];
  const r = calibrateFromJudged(events, 0.75, 1);
  assert.equal(r.recommended, 0.9);
  assert.ok(Math.abs(r.precisionAtRecommended! - 0.8) < 1e-9);
  assert.equal(r.curve.find((c) => c.sim === 0.9)!.acceptRateAtOrAbove, 1);
});

test("selectFromCurve: the best attainable point does not move with the target", () => {
  // What lets the panel show a "best attainable" operating point for a model
  // that missed the target, and keep showing the SAME one as the slider moves:
  // bestRate is the best any eligible prefix does, not the best that clears a
  // bar. Only requiredN and the blocker are target-dependent.
  // The top event is a reject, so EVERY eligible prefix carries one and no
  // prefix can ever reach 99% — while 50% is met all the way down. The best
  // prefix is 4/5 = 0.80 at sim 0.91 either way.
  const events = [
    { sim: 0.99, verdict: "reject" as const },
    { sim: 0.97, verdict: "accept" as const },
    { sim: 0.95, verdict: "accept" as const },
    { sim: 0.93, verdict: "accept" as const },
    { sim: 0.91, verdict: "accept" as const },
    { sim: 0.88, verdict: "reject" as const },
  ];
  const { curve } = calibrateFromJudged(events, 0.99, 2);
  const strict = selectFromCurve(curve, 0.99, 2).attainability;
  const loose = selectFromCurve(curve, 0.5, 2).attainability;

  assert.ok(Math.abs(strict.bestRate! - 0.8) < 1e-9);
  assert.equal(strict.bestRate, loose.bestRate);
  assert.deepEqual(strict.bestRateAt, { sim: 0.91, n: 5 });
  assert.deepEqual(strict.bestRateAt, loose.bestRateAt);
  assert.equal(strict.rejectsInBest, loose.rejectsInBest);
  // The target-dependent half: unreachable at 99% (needing n ≥ 100 to carry
  // that one reject), comfortably met at 50% (n ≥ 2 suffices). requiredN is
  // stated whenever the best prefix carries a reject, met or not — it answers
  // "how big would this have to get", which is as true at 50% as at 99%.
  assert.equal(strict.blocker, "target-unreachable");
  assert.equal(strict.requiredN, 100);
  assert.equal(loose.blocker, null);
  assert.equal(loose.requiredN, 2);
});

test("selectFromCurve: an empty curve is 'no-events', not a crash", () => {
  const r = selectFromCurve([], 0.99, 20);
  assert.equal(r.recommended, null);
  assert.equal(r.precisionAtRecommended, null);
  assert.equal(r.coverageAtRecommended, null);
  assert.equal(r.attainability.blocker, "no-events");
  assert.equal(r.attainability.bestRate, null);
  assert.equal(r.attainability.requiredN, null);
});

// --- AUC ---------------------------------------------------------------------

test("auc: perfect separation is 1, inverted is 0, and it's rank-based only", () => {
  const perfect = [
    { sim: 0.9, label: "same" as const },
    { sim: 0.8, label: "same" as const },
    { sim: 0.3, label: "different" as const },
    { sim: 0.1, label: "different" as const },
  ];
  assert.equal(auc(perfect), 1);

  // Same ORDER, wildly different scale — AUC must not move. This is the whole
  // reason it's here: cosine magnitudes aren't comparable across models.
  const rescaled = perfect.map((p) => ({ ...p, sim: p.sim * 0.1 + 0.5 }));
  assert.equal(auc(rescaled), 1);

  const inverted = perfect.map((p) => ({
    ...p,
    label: p.label === "same" ? ("different" as const) : ("same" as const),
  }));
  assert.equal(auc(inverted), 0);
});

test("auc: a full tie is 0.5 — ties split the win rather than going to sort order", () => {
  const allTied = [
    { sim: 0.9, label: "same" as const },
    { sim: 0.9, label: "same" as const },
    { sim: 0.9, label: "different" as const },
    { sim: 0.9, label: "different" as const },
  ];
  assert.equal(auc(allTied), 0.5);
  // And the answer can't depend on input order.
  assert.equal(auc([...allTied].reverse()), 0.5);
});

test("auc: one misordered pair costs exactly its share", () => {
  // 2 same × 2 different = 4 comparisons; the 0.5 "same" loses to the 0.8
  // "different" only. 3 wins out of 4.
  const pairs = [
    { sim: 0.9, label: "same" as const },
    { sim: 0.8, label: "different" as const },
    { sim: 0.5, label: "same" as const },
    { sim: 0.1, label: "different" as const },
  ];
  assert.equal(auc(pairs), 0.75);
});

test("auc: null when either class is missing", () => {
  assert.equal(auc([]), null);
  assert.equal(auc([{ sim: 0.9, label: "same" }]), null);
  assert.equal(auc([{ sim: 0.9, label: "different" }]), null);
});

// --- F6: argument order ------------------------------------------------------

test("entityGuardPasses: the reversed comparison F1 measured at 0.9962 is blocked", () => {
  assert.equal(
    entityGuardPasses(
      "In 1938, how many times larger was Japan's population compared to China's?",
      "In 1938, how many times larger was China's population compared to Japan's?",
    ),
    false,
  );
});

test("entityGuardPasses: the reversed ratio F3 hit is blocked", () => {
  assert.equal(
    entityGuardPasses(
      "What share of all munitions used by the Allied powers did the United States manufacture?",
      "What percentage of munitions manufactured by the United States were used by Allied powers?",
    ),
    false,
  );
});

test("entityOrderPasses: same order under a comparator passes", () => {
  assert.equal(
    entityOrderPasses(
      "how many times larger was Japan's population compared to China's",
      "Japan's population was how many times larger compared to China's?",
    ),
    true,
  );
});

test("entityOrderPasses: order alone is not enough — a direction marker is required", () => {
  // No comparator and no passive agent: word order here carries no relation, so
  // blocking on it would be pure recall cost.
  assert.equal(
    entityOrderPasses(
      "what did Germany and France sign in 1919",
      "what did France and Germany sign in 1919",
    ),
    true,
  );
});

test("entityOrderPasses: one shared entity has no order to reverse", () => {
  assert.equal(
    entityOrderPasses(
      "how much was paid by Germany",
      "how much was paid by Germany in total",
    ),
    true,
  );
});

test("entityOrderPasses: an entity only one side mentions does not trigger it", () => {
  assert.equal(
    entityOrderPasses(
      "what share of munitions came from the United States compared to Britain",
      "what share of munitions came from the United States compared to Britain, per Churchill",
    ),
    true,
  );
});

test("entityOrderPasses: question openers are not entities", () => {
  // "What" and "Which" are capitalised by grammar and land first in every
  // question — reading them as entities would invent order differences.
  assert.equal(
    entityOrderPasses(
      "What was produced by Japan compared to China?",
      "Which goods were produced by Japan compared to China?",
    ),
    true,
  );
});

test("entityOrderPasses: symmetric in its arguments", () => {
  const a = "how many times larger was Japan's population compared to China's";
  const b = "how many times larger was China's population compared to Japan's";
  assert.equal(entityOrderPasses(a, b), entityOrderPasses(b, a));
});

test("entityOrderPasses: a month moving between phrasings is not an order change", () => {
  // Every false block in the first F6 measurement was this shape: "by" as a
  // TEMPORAL preposition plus a month that sits at a different point in the
  // sentence. A date that genuinely differs is a numeral, which the token half
  // catches; the month itself is never the argument of a comparison.
  assert.equal(
    entityOrderPasses(
      "By the end of October 1916, what was the estimated aggregate figure for Russian military losses?",
      "What was the approximate combined total of Russian military losses by the end of October 1916?",
    ),
    true,
  );
});

test("entityOrderPasses: a curly apostrophe possessive is the same entity", () => {
  // The two reversals that motivated F6 are both possessive ("Japan's"), and a
  // question typed with a smart quote must not read as a different entity —
  // that would silently stop the check firing on exactly the case it exists for.
  assert.equal(
    entityOrderPasses(
      "how many times larger was Japan\u2019s population compared to China\u2019s",
      "how many times larger was China's population compared to Japan's",
    ),
    false,
  );
});
