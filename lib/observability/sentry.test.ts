// The wrapper's test door: an in-memory transport installed through initSentry
// (lib/observability/testing.ts), a dummy DSN, and no network. Proves a capture
// made through lib/observability/sentry arrives as an envelope carrying the
// request tags and the thrown error.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";

import {
  captureException,
  flushSentry,
  setRequestTags,
} from "./sentry";
import { initSentryInMemory, withRequestIsolation } from "./testing";

const events = initSentryInMemory();

test("an error thrown in an async fn arrives as one envelope with the request tags", async () => {
  setRequestTags({ userId: "u-1", configId: "c-1", route: "/api/test" });

  async function failing() {
    throw new Error("boom from the wrapper test");
  }
  let id = "";
  try {
    await failing();
  } catch (err) {
    id = captureException(err, { tags: { site: "test" } });
  }
  assert.ok(await flushSentry());

  assert.equal(events.length, 1);
  const event = events[0] as {
    event_id: string;
    tags: Record<string, string>;
    exception: { values: { value: string; stacktrace: { frames: { function?: string }[] } }[] };
  };
  assert.equal(event.event_id, id);
  assert.equal(event.tags["user.id"], "u-1");
  assert.equal(event.tags["config.id"], "c-1");
  assert.equal(event.tags.route, "/api/test");
  assert.equal(event.tags.site, "test");
  assert.equal(event.exception.values[0].value, "boom from the wrapper test");
  assert.ok(
    event.exception.values[0].stacktrace.frames.some((f) => f.function === "failing"),
    "stack names the throwing function",
  );
});

test("no request data rides along: a guest tag is the literal 'true', nothing else is added", async () => {
  events.length = 0;
  setRequestTags({ guest: true });
  captureException(new Error("guest"));
  assert.ok(await flushSentry());
  const event = events[0] as { tags: Record<string, string>; request?: unknown; user?: unknown };
  assert.equal(event.tags.guest, "true");
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
});

// The mechanism the NDJSON producer relies on (Trap 1): the producer runs after its
// handler has returned, re-entered through AsyncResource.bind. The handler's
// isolation scope must come back with it — and a second request tagging its own
// scope in between must not bleed in. The real ndjsonStream needs a database
// transaction, so its end-to-end case is test/integration/sentryNdjson.itest.ts.
test("tags set in a request survive an AsyncResource.bind re-entry after the request returns", async () => {
  events.length = 0;
  const producer = withRequestIsolation(() => {
    setRequestTags({ userId: "u-a", configId: "c-a", route: "/api/stream" });
    return AsyncResource.bind(async () => {
      try {
        throw new Error("thrown inside the producer");
      } catch (err) {
        return captureException(err, { tags: { site: "ndjson" } });
      }
    });
  });
  withRequestIsolation(() => setRequestTags({ userId: "u-b", configId: "c-b" }));

  const id = await producer();
  assert.ok(await flushSentry());
  assert.equal(events.length, 1);
  const event = events[0] as { event_id: string; tags: Record<string, string> };
  assert.equal(event.event_id, id);
  assert.equal(event.tags["config.id"], "c-a");
  assert.equal(event.tags["user.id"], "u-a");
  assert.equal(event.tags.route, "/api/stream");
  assert.equal(event.tags.site, "ndjson");
});
