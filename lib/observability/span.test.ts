// span.ts in both states it runs in: Sentry uninitialised (CI, a checkout with
// no DSN) — every call a no-op that changes nothing about the wrapped function —
// and initialised with the in-memory transport, where the nesting and the
// attributes arrive as one transaction.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { flushSentry } from "./sentry";
import { addAttr, currentSpanIs, setAttr, span } from "./span";
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
  addAttr("no.span", 1);
  assert.equal(currentSpanIs("rag.test"), false);
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

// Init is process-wide and cannot be undone, so the initialised tests run last
// and share one transport; each reads only the span names it made.
let tracing: ReturnType<typeof initSentryTracingInMemory> | undefined;
const inMemory = () => (tracing ??= initSentryTracingInMemory());

test("initialised: nested spans arrive parented, with their attributes", async () => {
  const shipped = inMemory();
  await span("rag.ask", { "config.id": "c-1" }, async (s) => {
    await span("rag.retrieve", { "retrieve.k": 5 }, async (r) => {
      await span("rag.retrieve.fuse", {}, async () => {});
      r.setAttr("retrieve.lanes.fired", "base,voyage-4-lite");
    });
    // The embed shape: a callee joins the span it is already in, and a value
    // that arrives per batch accumulates on it.
    await span("rag.embed", { "embed.count": 3 }, async () => {
      assert.equal(currentSpanIs("rag.embed"), true);
      assert.equal(currentSpanIs("rag.ask"), false);
      addAttr("embed.tokens", 40);
      addAttr("embed.tokens", 2);
    });
    assert.equal(currentSpanIs("rag.ask"), true);
    // After the child ends, the current span is the parent again.
    setAttr("answer.tokens.in", 120);
    s.setAttr("cache.outcome", "miss");
  });
  assert.ok(await flushSentry());

  const byName = new Map(shipped.map((sp) => [sp.name, sp]));
  assert.deepEqual([...byName.keys()].sort(), ["rag.ask", "rag.embed", "rag.retrieve", "rag.retrieve.fuse"]);
  assert.equal(byName.get("rag.embed")!.attributes["embed.tokens"], 42);
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

test("initialised: a root span starts its own trace even inside another span", async () => {
  const shipped = inMemory();
  shipped.length = 0;
  await span("rag.ask", {}, async () => {
    await span("job.slice", { "job.id": "j-1" }, async (s) => {
      await span("eval.score", { "eval.questions": 2 }, async () => {});
      s.setAttr("job.outcome", "finished");
    }, { root: true });
  });
  assert.ok(await flushSentry());

  const byName = new Map(shipped.map((sp) => [sp.name, sp]));
  const ask = byName.get("rag.ask")!;
  const slice = byName.get("job.slice")!;
  const score = byName.get("eval.score")!;
  assert.ok(slice.is_segment);
  assert.equal(slice.parent_span_id, undefined);
  assert.notEqual(slice.trace_id, ask.trace_id);
  assert.equal(score.parent_span_id, slice.span_id);
  assert.equal(slice.attributes["job.outcome"], "finished");
});
