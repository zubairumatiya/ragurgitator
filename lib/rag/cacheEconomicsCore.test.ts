import assert from "node:assert/strict";
import { test } from "node:test";

import { payoffAt, servedAt, type CacheEconomics } from "./cacheEconomicsCore";

const econ = (over: Partial<CacheEconomics> = {}): CacheEconomics => ({
  space: "voyage-4",
  liveThreshold: 0.95,
  censusFloor: 0.8,
  entries: 90,
  // 10 questions at or above the live 0.95, 10 more between the floor and it.
  bins: [
    [0.99, 4],
    [0.97, 3],
    [0.95, 3],
    [0.9, 6],
    [0.82, 4],
  ],
  guardBlocked: 0,
  savedPerHitUsd: 0.004,
  hitsPriced: 25,
  ...over,
});

test("servedAt: inclusive at τ, and stops at the first bin below it", () => {
  const bins = econ().bins;
  assert.equal(servedAt(bins, 0.95), 10);
  assert.equal(servedAt(bins, 0.951), 7);
  assert.equal(servedAt(bins, 0.9), 16);
  assert.equal(servedAt(bins, 1), 0);
});

// THE LOAD-BEARING PROPERTY. The denominator is "questions this cache has seen",
// which is a fact about the traffic and not about the setting — a question the
// cache serves is one it did not bank, so lowering τ moves it between the two
// columns without changing the total. A denominator that moved with τ would make
// every rate on the readout incomparable with every other.
test("payoffAt: the denominator does not move when τ does", () => {
  const e = econ();
  const seen = payoffAt(e, 0.95)!.questionsSeen;
  assert.equal(seen, 100); // 90 banked + 10 served at the live threshold
  for (const tau of [0.82, 0.9, 0.97, 0.999]) {
    assert.equal(payoffAt(e, tau)!.questionsSeen, seen);
  }
});

test("payoffAt: hit rate and money are the served count, priced from the ledger", () => {
  const at = payoffAt(econ(), 0.9)!;
  assert.equal(at.served, 16);
  assert.equal(at.hitRate, 0.16);
  assert.equal(at.savedUsd, 16 * 0.004);
  // Per 1,000 questions: the rate times the realized per-hit saving.
  assert.ok(Math.abs(at.perThousandUsd! - 0.16 * 1000 * 0.004) < 1e-12);
});

test("payoffAt: no priced hit leaves the money null rather than zero", () => {
  const at = payoffAt(econ({ savedPerHitUsd: null, hitsPriced: 0 }), 0.9)!;
  assert.equal(at.savedUsd, null);
  assert.equal(at.perThousandUsd, null);
  assert.equal(at.hitRate, 0.16); // the measurement still stands
});

// Below the shadow-log floor nothing was recorded, so the census can only ever
// under-count there. The flag is what stops the readout presenting a lower bound
// as a measurement.
test("payoffAt: a τ under the census floor is flagged", () => {
  assert.equal(payoffAt(econ(), 0.82)!.belowCensusFloor, false);
  assert.equal(payoffAt(econ(), 0.79)!.belowCensusFloor, true);
});

test("payoffAt: nothing seen at all is null, not a 0/0 rate", () => {
  assert.equal(payoffAt(econ({ entries: 0, bins: [] }), 0.95), null);
});
