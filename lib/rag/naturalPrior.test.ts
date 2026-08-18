import assert from "node:assert/strict";
import { test } from "node:test";

import { priorCurve, precisionAt, recommendUnderPrior, wilson } from "./naturalPrior";

const ev = (sim: number, verdict: "accept" | "reject") => ({ sim, verdict });

test("priorCurve: at the sample's own prior it reproduces the raw precision", () => {
  // 6 accepts / 6 rejects, so the sample prior is 0.5 — reweighting to 0.5 must
  // be a no-op, which is the identity that makes the whole estimator checkable.
  const events = [
    ev(0.99, "accept"), ev(0.98, "accept"), ev(0.97, "reject"),
    ev(0.96, "accept"), ev(0.95, "accept"), ev(0.94, "reject"),
    ev(0.93, "accept"), ev(0.92, "reject"), ev(0.91, "accept"),
    ev(0.9, "reject"), ev(0.89, "reject"), ev(0.88, "reject"),
  ];
  const curve = priorCurve(events, 0.5)!;
  for (const p of curve.points) {
    const raw = p.accepts / (p.accepts + p.rejects);
    assert.ok(Math.abs(p.precision! - raw) < 1e-12, `${p.sim}: ${p.precision} vs ${raw}`);
  }
});

test("priorCurve: a rarer negative raises precision, a commoner one lowers it", () => {
  const events = [
    ev(0.99, "accept"), ev(0.98, "accept"), ev(0.97, "reject"), ev(0.96, "reject"),
  ];
  const at = (prior: number) => precisionAt(priorCurve(events, prior)!, 0.98)!.precision!;
  // Only accepts are above 0.98, so any prior gives precision 1 there.
  assert.equal(at(0.5), 1);
  // Below the negatives, the mix matters and moves monotonically with the prior.
  const low = precisionAt(priorCurve(events, 0.1)!, 0.96)!.precision!;
  const mid = precisionAt(priorCurve(events, 0.5)!, 0.96)!.precision!;
  const high = precisionAt(priorCurve(events, 0.9)!, 0.96)!.precision!;
  assert.ok(low < mid && mid < high);
  assert.ok(Math.abs(mid - 0.5) < 1e-12); // the sample's own rate at the bottom
});

test("priorCurve: one point per distinct sim, read at the tie boundary", () => {
  const events = [ev(0.95, "accept"), ev(0.95, "reject"), ev(0.9, "accept")];
  const curve = priorCurve(events, 0.5)!;
  assert.deepEqual(curve.points.map((p) => p.sim), [0.95, 0.9]);
  // The 0.95 point describes BOTH tied events, not just the first sorted one.
  assert.equal(curve.points[0].accepts, 1);
  assert.equal(curve.points[0].rejects, 1);
});

test("priorCurve: refuses a one-class sample and an impossible prior", () => {
  assert.equal(priorCurve([ev(0.9, "accept"), ev(0.8, "accept")], 0.5), null);
  assert.equal(priorCurve([ev(0.9, "reject")], 0.5), null);
  assert.equal(priorCurve([ev(0.9, "accept"), ev(0.8, "reject")], 0), null);
  assert.equal(priorCurve([ev(0.9, "accept"), ev(0.8, "reject")], 1), null);
});

test("precisionAt: reads the whole served set at or above τ, and null below the sample", () => {
  const events = [ev(0.99, "accept"), ev(0.95, "reject"), ev(0.9, "accept")];
  const curve = priorCurve(events, 0.5)!;
  assert.equal(precisionAt(curve, 0.96)!.sim, 0.99);
  assert.equal(precisionAt(curve, 0.95)!.sim, 0.95);
  // A τ between points reads the last point at or above it, not the next one down.
  assert.equal(precisionAt(curve, 0.93)!.sim, 0.95);
  assert.equal(precisionAt(curve, 0.999), null);
});

test("recommendUnderPrior: the LOWEST τ that still clears the target", () => {
  const events = [
    ev(0.99, "accept"), ev(0.98, "accept"), ev(0.97, "accept"),
    ev(0.96, "reject"), ev(0.95, "accept"), ev(0.94, "reject"),
  ];
  const curve = priorCurve(events, 0.5)!;
  const rec = recommendUnderPrior(curve, 0.9, 1)!;
  assert.equal(rec.sim, 0.97); // 0.96 admits a reject and drops below 0.9
  assert.ok(rec.precision! >= 0.9);
  // minSamples can veto an otherwise-clearing point.
  assert.equal(recommendUnderPrior(curve, 0.9, 5), null);

  // An unreachable target has no recommendation rather than a bad one. It takes
  // a reject at the TOP of the ranking to make one unreachable: while the
  // highest-scoring events are all accepts, that prefix is 100% precise and
  // clears any target — which is the ordinary case and not a failure.
  const topReject = priorCurve(
    [ev(0.99, "reject"), ev(0.98, "accept"), ev(0.97, "accept")],
    0.5,
  )!;
  assert.equal(recommendUnderPrior(topReject, 0.999, 1), null);
});

test("wilson: stays inside [0,1] where a normal approximation would not", () => {
  const { lo, hi } = wilson(90, 91);
  assert.ok(hi <= 1 && lo > 0.9);
  // 90/91 + 1.96·se would exceed 1 under the normal approximation.
  assert.ok(0.989 + 1.96 * Math.sqrt((0.989 * 0.011) / 91) > 1);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1 });
});
