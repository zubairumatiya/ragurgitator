import assert from "node:assert/strict";
import test from "node:test";

import {
  NEVER_STOP,
  isCancelled,
  registerRun,
  requestCancel,
  resetRunsForTest,
  unregisterRun,
} from "./cancelRegistry";

// The registry is the only thing standing between "Cancel" and a detached
// producer that would otherwise keep spending after the page is gone, and the
// only thing standing between one user and another user's runs. Both halves are
// here.

test("registerRun: a fresh run is not cancelled, and cancelling it sticks", () => {
  resetRunsForTest();
  const runId = registerRun("user-a");
  assert.equal(isCancelled(runId), false);
  assert.equal(requestCancel(runId, "user-a"), true);
  assert.equal(isCancelled(runId), true);
  // Idempotent: the UI can double-click Cancel, and a retry after a flaky POST
  // must not report "not found" for a run that is very much still there.
  assert.equal(requestCancel(runId, "user-a"), true);
});

test("registerRun: ids are distinct, so cancelling one leaves the others alone", () => {
  resetRunsForTest();
  const a = registerRun("user-a");
  const b = registerRun("user-a");
  assert.notEqual(a, b);
  requestCancel(a, "user-a");
  assert.equal(isCancelled(a), true);
  assert.equal(isCancelled(b), false);
});

test("requestCancel: another user's run is untouched and reported as not found", () => {
  resetRunsForTest();
  const runId = registerRun("user-a");
  assert.equal(requestCancel(runId, "user-b"), false);
  // The point of the check: not merely a false return, but a run that keeps
  // running. A cross-tenant cancel is a denial of service if it lands.
  assert.equal(isCancelled(runId), false);
  // Indistinguishable from an id that never existed, so the reply cannot be
  // used to probe which run ids are real.
  assert.equal(requestCancel("00000000-0000-4000-8000-000000000000", "user-b"), false);
});

test("requestCancel: an unknown runId is a no-op, not a throw", () => {
  resetRunsForTest();
  // The UI POSTs whatever id the stream announced; by the time it arrives the
  // run may have finished (or be streaming from another instance).
  assert.equal(requestCancel("not-a-registered-id", "user-a"), false);
  assert.equal(isCancelled("not-a-registered-id"), false);
});

test("unregisterRun: a completed run is forgotten, so its id stops being cancellable", () => {
  resetRunsForTest();
  const runId = registerRun("user-a");
  unregisterRun(runId);
  assert.equal(requestCancel(runId, "user-a"), false);
  // An unregistered id reads as NOT cancelled — nobody is waiting on it, and a
  // recycled read must never make the next loop think it should stop.
  assert.equal(isCancelled(runId), false);
  // The stream's `finally` also runs on the error and disconnect paths, so this
  // has to tolerate being called twice.
  unregisterRun(runId);
});

test("unregisterRun: a cancelled-then-finished run does not linger as cancelled", () => {
  resetRunsForTest();
  const runId = registerRun("user-a");
  requestCancel(runId, "user-a");
  unregisterRun(runId);
  assert.equal(isCancelled(runId), false);
});

test("NEVER_STOP: the default for every non-streamed caller says 'keep going'", () => {
  assert.equal(NEVER_STOP(), false);
});
