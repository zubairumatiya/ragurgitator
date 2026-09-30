// The wrapper's test door: an in-memory transport installed through initSentry
// (lib/observability/testing.ts), a dummy DSN, and no network. Proves a capture
// made through lib/observability/sentry carries the request's ids as explicit tags
// read from lib/log's context — and nothing from any Sentry scope, which on Vercel
// is shared between requests (docs/obs-1-sentry-plan.md, Phase 4 follow-up).
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";

import { withLogContext } from "../log";
import { captureException, flushSentry, onRequestError, wasCaptured } from "./sentry";
import { initSentryInMemory } from "./testing";

const events = initSentryInMemory();

type Event = {
  event_id: string;
  tags: Record<string, string>;
  request?: unknown;
  user?: unknown;
  exception: { values: { value: string; stacktrace: { frames: { function?: string }[] } }[] };
};

test("a capture carries the log context's ids as tags, plus the caller's own", async () => {
  events.length = 0;
  async function failing() {
    throw new Error("boom from the wrapper test");
  }
  const id = await withLogContext(
    { userId: "u-1", configId: "c-1", route: "/api/test", guest: true },
    async () => {
      try {
        await failing();
      } catch (err) {
        return captureException(err, { tags: { site: "test" } });
      }
      return "";
    },
  );
  assert.ok(await flushSentry());

  assert.equal(events.length, 1);
  const event = events[0] as Event;
  assert.equal(event.event_id, id);
  assert.equal(event.tags["user.id"], "u-1");
  assert.equal(event.tags["config.id"], "c-1");
  assert.equal(event.tags.route, "/api/test");
  assert.equal(event.tags.guest, "true");
  assert.equal(event.tags.site, "test");
  assert.equal(event.request, undefined, "no request data rides along");
  assert.equal(event.user, undefined);
  assert.equal(event.exception.values[0].value, "boom from the wrapper test");
  assert.ok(
    event.exception.values[0].stacktrace.frames.some((f) => f.function === "failing"),
    "stack names the throwing function",
  );
});

test("outside any context a capture names no user, config or route", async () => {
  events.length = 0;
  captureException(new Error("bare"));
  assert.ok(await flushSentry());
  // Sentry omits `tags` entirely when there are none.
  const tags = (events[0] as Event).tags ?? {};
  for (const k of ["user.id", "config.id", "route", "guest", "job.id"]) {
    assert.equal(tags[k], undefined, `${k} must be absent`);
  }
});

// The failure that shipped — ids from one request on another's event — cannot be
// reproduced here: a Sentry scope tag does merge into events, which is exactly why
// nothing in lib/observability may set one. scripts/guards.ts sweep 11 enforces that.

// The mechanism the NDJSON producer relies on (Trap 1): the producer runs after its
// handler has returned, re-entered through AsyncResource.bind, which restores the
// log context. A second request's context in between must not bleed in. The real
// ndjsonStream needs a database transaction: test/integration/sentryNdjson.itest.ts.
test("the log context survives an AsyncResource.bind re-entry after the request returns", async () => {
  events.length = 0;
  const producer = withLogContext({ userId: "u-a", configId: "c-a", route: "/api/stream" }, () =>
    AsyncResource.bind(async () => {
      try {
        throw new Error("thrown inside the producer");
      } catch (err) {
        return captureException(err, { tags: { site: "ndjson" } });
      }
    }),
  );
  withLogContext({ userId: "u-b", configId: "c-b" }, () => {});

  const id = await producer();
  assert.ok(await flushSentry());
  assert.equal(events.length, 1);
  const event = events[0] as Event;
  assert.equal(event.event_id, id);
  assert.equal(event.tags["config.id"], "c-a");
  assert.equal(event.tags["user.id"], "u-a");
  assert.equal(event.tags.route, "/api/stream");
  assert.equal(event.tags.site, "ndjson");
});

// An error a scope boundary captured on its way out reaches Next's hook too; the
// hook must not report it a second time, and must still report what it alone sees.
test("onRequestError skips errors already captured and tags the rest with the path", async () => {
  events.length = 0;
  const request = { path: "/api/x", method: "GET", headers: {} };
  const ctx = { routerKind: "App Router", routePath: "/api/x", routeType: "route" } as const;

  const seen = new Error("captured at the boundary");
  captureException(seen);
  assert.ok(wasCaptured(seen));
  onRequestError(seen, request, ctx);

  const unseen = new Error("escaped a page with no boundary");
  onRequestError(unseen, request, ctx);
  assert.ok(await flushSentry());

  assert.equal(events.length, 2, "one for the boundary capture, one for the hook");
  // Envelope order is not capture order: the hook's own flush can send first.
  const values = (events as Event[]).map((e) => e.exception.values[0].value).sort();
  assert.deepEqual(values, ["captured at the boundary", "escaped a page with no boundary"]);
  const hookEvent = (events as Event[]).find(
    (e) => e.exception.values[0].value === "escaped a page with no boundary",
  )!;
  assert.equal(hookEvent.tags.route, "/api/x");
});

// The boundary must let Next's control flow through unreported: a redirect() is a
// thrown error with a digest, and reporting it would page on every login wall.
test("capturingEscapes reports application errors and passes Next control flow through", async () => {
  const { capturingEscapes, isNextControlFlow } = await import("./escapes");
  events.length = 0;
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
  await assert.rejects(capturingEscapes(async () => { throw redirect; }), redirect);
  const wrapped = new Error("outer", { cause: Object.assign(new Error("dyn"), { digest: "DYNAMIC_SERVER_USAGE" }) });
  assert.ok(isNextControlFlow(wrapped), "a control-flow cause is control flow");
  const app = new Error("a real failure");
  await assert.rejects(capturingEscapes(async () => { throw app; }), app);
  assert.ok(wasCaptured(app));
  assert.ok(!wasCaptured(redirect));
  assert.ok(await flushSentry());
  assert.equal(events.length, 1);
  assert.equal((events[0] as Event).exception.values[0].value, "a real failure");
});
