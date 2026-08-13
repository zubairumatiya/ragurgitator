import assert from "node:assert/strict";
import test from "node:test";

import {
  isAdvanceable,
  isCancellable,
  isStalled,
  isTerminal,
  progressPercent,
  remainingSeconds,
} from "@/lib/jobs/types";

test("cancelling is advanceable but not cancellable", () => {
  // The distinction is load-bearing: a cancelling job still needs one more slice
  // to notice the flag and write the terminal status — nothing else moves it — but
  // offering Cancel again on it would be a button that does nothing.
  assert.equal(isAdvanceable("cancelling"), true);
  assert.equal(isCancellable("cancelling"), false);
  assert.equal(isCancellable("running"), true);
  assert.equal(isCancellable("queued"), true);
});

test("terminal statuses stop advancing", () => {
  for (const s of ["succeeded", "failed", "cancelled"] as const) {
    assert.equal(isTerminal(s), true);
    assert.equal(isAdvanceable(s), false);
    assert.equal(isCancellable(s), false);
  }
});

test("progress is clamped, because total_units is only an estimate", () => {
  assert.equal(progressPercent({ totalUnits: 200, doneUnits: 50 }), 25);
  // A job that found more work than plan() predicted must not draw past the end.
  assert.equal(progressPercent({ totalUnits: 100, doneUnits: 140 }), 100);
  // No denominator yet — the bar has to render as indeterminate, not as 0%.
  assert.equal(progressPercent({ totalUnits: 0, doneUnits: 0 }), null);
});

test("remaining time comes from observed throughput, not the original estimate", () => {
  // 100 of 400 units in 60s => 0.6s/unit => 180s left.
  assert.equal(remainingSeconds({ totalUnits: 400, doneUnits: 100 }, 60_000), 180);
  // Nothing done yet: no rate to extrapolate from.
  assert.equal(remainingSeconds({ totalUnits: 400, doneUnits: 0 }, 60_000), null);
  // Already at (or past) the estimate: no honest number to give.
  assert.equal(remainingSeconds({ totalUnits: 400, doneUnits: 400 }, 60_000), null);
});

test("a job is stalled when it should be advancing and holds no live lease", () => {
  const now = Date.parse("2026-08-13T12:00:00Z");
  const live = new Date(now + 60_000).toISOString();
  const dead = new Date(now - 60_000).toISOString();

  // The normal healthy case: someone holds the lease, so the janitor leaves it be.
  assert.equal(isStalled({ status: "running", leaseExpiresAt: live }, now), false);
  // The case the janitor exists for: a chain that broke mid-hop.
  assert.equal(isStalled({ status: "running", leaseExpiresAt: dead }, now), true);
  // Queued with no lease means the launch fired but the first tick never landed.
  assert.equal(isStalled({ status: "queued", leaseExpiresAt: null }, now), true);
  // A finished job is never stalled, however long ago its lease lapsed.
  assert.equal(isStalled({ status: "succeeded", leaseExpiresAt: dead }, now), false);
});
