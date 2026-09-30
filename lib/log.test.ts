// Every line lib/log.ts emits parses under lib/log.schema.ts and carries the context
// withLogContext set — including after an AsyncResource.bind re-entry, which is how
// the NDJSON producer runs. The real ndjsonStream needs a database transaction, so
// its end-to-end case is test/integration/logNdjson.itest.ts.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";

import { annotateLogContext, log, logContext, withLogContext } from "./log";
import { logLineSchema, type LogLine } from "./log.schema";

function capturing(fn: () => void | Promise<void>): Promise<LogLine[]> {
  const cap = log.__capture();
  return Promise.resolve()
    .then(fn)
    .finally(cap.stop)
    .then(() => cap.lines.map((l) => logLineSchema.parse(JSON.parse(l))));
}

test("outside a scope a line still parses and carries no context", async () => {
  const [line] = await capturing(() => log.info("bare", { n: 1 }));
  assert.equal(line.msg, "bare");
  assert.equal(line.level, "info");
  assert.equal(line.requestId, undefined);
  assert.equal(line.n, 1);
  assert.deepEqual(logContext(), {});
});

test("nested scopes merge, and every line carries the merged context", async () => {
  const lines = await capturing(() =>
    withLogContext({ requestId: "req-1", route: "/api/eval", configId: "c-1" }, () => {
      log.warn("outer");
      withLogContext({ userId: "u-1" }, () => log.error("inner"));
    }),
  );
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.requestId, "req-1");
    assert.equal(line.route, "/api/eval");
    assert.equal(line.configId, "c-1");
  }
  assert.equal(lines[0].userId, undefined);
  assert.equal(lines[1].userId, "u-1");
});

test("a scope without a requestId gets a fresh 8-hex one", async () => {
  const [line] = await capturing(() => withLogContext({ jobId: "j-1" }, () => log.info("slice")));
  assert.match(line.requestId ?? "", /^[0-9a-f]{8}$/);
  assert.equal(line.jobId, "j-1");
});

test("the context survives an AsyncResource.bind re-entry after the scope returns", async () => {
  const producer = withLogContext({ requestId: "req-a", configId: "c-a", userId: "u-a" }, () =>
    AsyncResource.bind(async () => {
      await new Promise((r) => setTimeout(r, 1));
      log.info("from the producer");
    }),
  );
  const lines = await capturing(async () => {
    // A second request in between must not bleed in.
    withLogContext({ requestId: "req-b", configId: "c-b" }, () => log.info("other request"));
    await producer();
  });
  const fromProducer = lines.find((l) => l.msg === "from the producer");
  assert.equal(fromProducer?.requestId, "req-a");
  assert.equal(fromProducer?.configId, "c-a");
  assert.equal(fromProducer?.userId, "u-a");
});

test("annotateLogContext reaches later lines of the same scope", async () => {
  const lines = await capturing(() =>
    withLogContext({ requestId: "req-g" }, () => {
      log.info("before");
      annotateLogContext({ guest: true });
      log.info("after");
    }),
  );
  assert.equal(lines[0].guest, undefined);
  assert.equal(lines[1].guest, true);
});

test("an Error field serializes to name, message and stack", async () => {
  const [line] = await capturing(() => log.error("failed", { err: new TypeError("bad input") }));
  const err = line.err as { name: string; message: string; stack: string };
  assert.equal(err.name, "TypeError");
  assert.equal(err.message, "bad input");
  assert.match(err.stack, /bad input/);
});

test("fields cannot overwrite t, level or msg", async () => {
  const [line] = await capturing(() => log.warn("real", { msg: "fake", level: "debug", t: "x" }));
  assert.equal(line.msg, "real");
  assert.equal(line.level, "warn");
});

test("debug is dropped unless LOG_LEVEL=debug", async () => {
  const prev = process.env.LOG_LEVEL;
  try {
    delete process.env.LOG_LEVEL;
    assert.equal((await capturing(() => log.debug("hidden"))).length, 0);
    process.env.LOG_LEVEL = "debug";
    assert.equal((await capturing(() => log.debug("shown")))[0].level, "debug");
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
});

test("a circular field degrades to a marker line instead of throwing", async () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  const [line] = await capturing(() => log.info("loop", { loop }));
  assert.equal(line.msg, "loop");
  assert.equal(line.logError, "unserializable fields");
});
