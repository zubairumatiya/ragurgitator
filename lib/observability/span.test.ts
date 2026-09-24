// span.ts in both states it runs in: Sentry uninitialised (CI, a checkout with
// no DSN) — every call a no-op that changes nothing about the wrapped function —
// and initialised with the in-memory transport, where the nesting and the
// attributes arrive as one transaction.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { flushSentry } from "./sentry";
import { setAttr, span } from "./span";
import { initSentryTracingInMemory } from "./testing";
import { PRODUCTION_TRACE_RATE, tracesSamplerFor } from "./sampler";

test("uninitialised: span returns the callback's value and setAttr is inert", async () => {
  const out = await span("rag.test", { "config.id": "c-1", skipped: undefined }, async (s) => {
    s.setAttr("n", 3);
    s.setAttr("absent", undefined);
    setAttr("outer", true);
    return 42;
  });
  assert.equal(out, 42);
  setAttr("no.span", "fine");
});

test("uninitialised: an error thrown in the callback propagates unchanged", async () => {
  const err = new Error("from inside");
  await assert.rejects(
    span("rag.test", {}, async () => {
      throw err;
    }),
    (e) => e === err,
  );
});

test("sampler: production samples a fifth, everything else all; a parent's decision wins", () => {
  const inherit = (parent: boolean | undefined) => (rate: number) =>
    parent === undefined ? rate : parent ? 1 : 0;
  assert.equal(tracesSamplerFor("production")({ inheritOrSampleWith: inherit(undefined) }), PRODUCTION_TRACE_RATE);
  assert.equal(tracesSamplerFor("preview")({ inheritOrSampleWith: inherit(undefined) }), 1);
  assert.equal(tracesSamplerFor(undefined)({ inheritOrSampleWith: inherit(undefined) }), 1);
  assert.equal(tracesSamplerFor("production")({ inheritOrSampleWith: inherit(true) }), 1);
  assert.equal(tracesSamplerFor("preview")({ inheritOrSampleWith: inherit(false) }), 0);
});

// Last: init is process-wide and cannot be undone.
test("initialised: nested spans arrive parented, with their attributes", async () => {
  const shipped = initSentryTracingInMemory();
  await span("rag.ask", { "config.id": "c-1" }, async (s) => {
    await span("rag.retrieve", { "retrieve.k": 5 }, async (r) => {
      await span("rag.retrieve.fuse", {}, async () => {});
      r.setAttr("retrieve.lanes.fired", "base,voyage-4-lite");
    });
    // After the child ends, the current span is the parent again.
    setAttr("answer.tokens.in", 120);
    s.setAttr("cache.outcome", "miss");
  });
  assert.ok(await flushSentry());

  const byName = new Map(shipped.map((sp) => [sp.name, sp]));
  assert.deepEqual([...byName.keys()].sort(), ["rag.ask", "rag.retrieve", "rag.retrieve.fuse"]);
  const root = byName.get("rag.ask")!;
  const retrieve = byName.get("rag.retrieve")!;
  const fuse = byName.get("rag.retrieve.fuse")!;
  assert.ok(root.is_segment);
  assert.equal(retrieve.parent_span_id, root.span_id);
  assert.equal(fuse.parent_span_id, retrieve.span_id);
  assert.equal(root.attributes["config.id"], "c-1");
  assert.equal(root.attributes["cache.outcome"], "miss");
  assert.equal(root.attributes["answer.tokens.in"], 120);
  assert.equal(retrieve.attributes["retrieve.k"], 5);
  assert.equal(retrieve.attributes["retrieve.lanes.fired"], "base,voyage-4-lite");
});
