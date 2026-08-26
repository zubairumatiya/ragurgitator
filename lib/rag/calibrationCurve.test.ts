// thinCurve — phase 1 of docs/demo-cache-lab-plan.md.
//
// The demo publishes the cache-key sweep's RESULT so a guest's precision slider
// is live on page load. A full CalibrationResult carries one curve point per
// judged pair, which is ~500 KB across eleven models — so the published form is
// thinned to the points the slider can actually reach.
//
// THE CLAIM UNDER TEST IS THAT THIS COSTS NOTHING: at every one of the slider's
// 101 positions, selectFromCurve must return exactly what it returned on the
// full curve. Not "close" — the same τ, the same precision, the same recall, and
// the same attainability report, since the panel renders all four. A thinning
// that were merely approximate would put numbers on screen that are not the ones
// that would be applied, which is the single thing calibrationCurve.ts exists to
// prevent.
import assert from "node:assert/strict";
import test from "node:test";

import {
  packCurve,
  selectFromCurve,
  sliderTargets,
  thinCurve,
  unpackCurve,
  type CurvePoint,
} from "@/lib/rag/calibrationCurve";

// Build a curve the way calibrateFromJudged does — sims descending, running
// accept rate, running recall — so the test is exercising real curve shapes
// rather than arbitrary numbers.
function curveOf(events: { sim: number; verdict: "accept" | "reject" }[]): CurvePoint[] {
  const sorted = [...events].sort((a, b) => b.sim - a.sim);
  const totalAccepts = sorted.filter((e) => e.verdict === "accept").length;
  let accepts = 0;
  return sorted.map((e, k) => {
    if (e.verdict === "accept") accepts++;
    return {
      sim: e.sim,
      acceptRateAtOrAbove: accepts / (k + 1),
      coverageAtOrAbove: totalAccepts === 0 ? 0 : accepts / totalAccepts,
      n: k + 1,
    };
  });
}

// A deterministic pseudo-random sample: separable-ish, with the overlap band a
// real pair set has. Seeded by hand so a failure is reproducible.
function sample(n: number, seed: number) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const events: { sim: number; verdict: "accept" | "reject" }[] = [];
  for (let i = 0; i < n; i++) {
    const accept = rnd() < 0.55;
    // Ties on purpose: sims rounded to 3dp, which is where tie groups come from
    // in practice and where the tie-boundary rule earns its keep.
    const sim = Number(((accept ? 0.75 : 0.55) + rnd() * 0.4).toFixed(3));
    events.push({ sim, verdict: accept ? "accept" : "reject" });
  }
  return events;
}

const MIN_SAMPLES = 20;

test("the slider grid is the panel's 101 positions, ascending", () => {
  const targets = sliderTargets();
  assert.equal(targets.length, 101);
  assert.equal(targets[0], 0.5);
  assert.equal(targets[targets.length - 1], 1);
  assert.ok(targets.every((t, i) => i === 0 || t > targets[i - 1]));
});

test("thinning is lossless at every slider position", () => {
  for (const seed of [1, 7, 99, 12345]) {
    const full = curveOf(sample(510, seed));
    const thin = thinCurve(full, sliderTargets(), MIN_SAMPLES);
    assert.ok(thin.length < full.length, "nothing was thinned");
    for (const target of sliderTargets()) {
      assert.deepEqual(
        selectFromCurve(thin, target, MIN_SAMPLES),
        selectFromCurve(full, target, MIN_SAMPLES),
        `seed ${seed} disagreed at target ${target}`,
      );
    }
  }
});

test("a one-class sample stays a one-class sample after thinning", () => {
  // The blocker that reads "100% precision" if the totals are lost — it is
  // derived from the curve's LAST point, which is why thinning always keeps it.
  const full = curveOf(
    Array.from({ length: 60 }, (_, i) => ({
      sim: Number((0.9 - i * 0.001).toFixed(3)),
      verdict: "accept" as const,
    })),
  );
  const thin = thinCurve(full, sliderTargets(), MIN_SAMPLES);
  const sel = selectFromCurve(thin, 0.99, MIN_SAMPLES);
  assert.equal(sel.recommended, null);
  assert.equal(sel.attainability.blocker, "one-class-sample");
  assert.deepEqual(sel, selectFromCurve(full, 0.99, MIN_SAMPLES));
});

test("a curve shorter than minSamples thins to something that still says so", () => {
  const full = curveOf(sample(8, 3));
  const thin = thinCurve(full, sliderTargets(), MIN_SAMPLES);
  assert.deepEqual(
    selectFromCurve(thin, 0.95, MIN_SAMPLES),
    selectFromCurve(full, 0.95, MIN_SAMPLES),
  );
  assert.equal(selectFromCurve(thin, 0.95, MIN_SAMPLES).attainability.blocker, "below-min-samples");
});

test("an empty curve thins to an empty curve", () => {
  assert.deepEqual(thinCurve([], sliderTargets(), MIN_SAMPLES), []);
});

// --- packing, phase 1.5 -----------------------------------------------------
//
// The stored form drops the two long float fields and keeps `accepts` instead.
// The claim is the same one thinning makes and it has to be checked the same
// way: not "close enough to plot", but the same τ, precision, recall and
// attainability at every position the slider can reach. The rounding variant of
// this idea (sims to 6dp) fails exactly that test, which is why the packing is
// arithmetic rather than approximation.

test("packing round-trips a curve bit-for-bit", () => {
  for (const seed of [1, 7, 99, 12345]) {
    const full = curveOf(sample(510, seed));
    assert.deepEqual(unpackCurve(packCurve(full)), full, `seed ${seed} did not round-trip`);
  }
});

test("packing is lossless at every slider position, on the thinned curve", () => {
  // The composition that actually ships: thin, then pack, then read on the
  // client. Checked end to end because either step alone being lossless would
  // not prove the pair is.
  for (const seed of [1, 7, 99, 12345]) {
    const full = curveOf(sample(510, seed));
    const shipped = unpackCurve(packCurve(thinCurve(full, sliderTargets(), MIN_SAMPLES)));
    for (const target of sliderTargets()) {
      assert.deepEqual(
        selectFromCurve(shipped, target, MIN_SAMPLES),
        selectFromCurve(full, target, MIN_SAMPLES),
        `seed ${seed} disagreed at target ${target}`,
      );
    }
  }
});

test("packing is smaller than the form it replaces", () => {
  // The whole reason for the encoding. Asserted rather than measured once in a
  // commit message, because a future field added to CurvePoint could quietly
  // make the packed form the larger one.
  const thin = thinCurve(curveOf(sample(510, 1)), sliderTargets(), MIN_SAMPLES);
  const packed = JSON.stringify(packCurve(thin)).length;
  assert.ok(packed * 2 < JSON.stringify(thin).length, `packed ${packed} bytes is not much smaller`);
});

test("an all-reject curve keeps its zero recall through the round trip", () => {
  // totalAccepts is 0, so unpacking must reproduce the literal 0 that
  // calibrateFromJudged writes rather than dividing and getting NaN.
  const full = curveOf(
    Array.from({ length: 30 }, (_, i) => ({
      sim: Number((0.9 - i * 0.001).toFixed(3)),
      verdict: "reject" as const,
    })),
  );
  const back = unpackCurve(packCurve(full));
  assert.deepEqual(back, full);
  assert.ok(back.every((p) => p.coverageAtOrAbove === 0));
});

test("an empty curve packs and unpacks to an empty curve", () => {
  assert.deepEqual(unpackCurve(packCurve([])), []);
});
