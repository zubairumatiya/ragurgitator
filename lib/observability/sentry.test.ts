// The wrapper's test door: an in-memory transport installed through initSentry, a
// dummy DSN, and no network. Proves a capture made through lib/observability/sentry
// arrives as an envelope carrying the request tags and the thrown error.
//
// Run with: pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Sentry from "@sentry/nextjs";

import {
  captureException,
  flushSentry,
  initSentry,
  setRequestTags,
} from "./sentry";

type Item = { type: string; payload: Record<string, unknown> };
const events: Record<string, unknown>[] = [];

// An envelope is newline-separated JSON: one envelope header, then header/payload
// pairs. Only event items are kept.
function parse(body: string | Uint8Array): Item[] {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const lines = text.split("\n").filter(Boolean);
  const items: Item[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    items.push({ type: JSON.parse(lines[i]).type, payload: JSON.parse(lines[i + 1]) });
  }
  return items;
}

initSentry({
  dsn: "https://public@o0.ingest.sentry.io/0",
  tracesSampleRate: 0,
  transport: (options: Parameters<typeof Sentry.createTransport>[0]) =>
    Sentry.createTransport(options, async (request) => {
      for (const item of parse(request.body)) {
        if (item.type === "event") events.push(item.payload);
      }
      return { statusCode: 200 };
    }),
});

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
