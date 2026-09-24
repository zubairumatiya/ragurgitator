// THE NDJSON PRODUCER'S SENTRY CAPTURE, THROUGH THE REAL ndjsonStream.
//
// Trap 1 in docs/obs-1-sentry-plan.md: the producer runs after the handler has
// returned, so Next's onRequestError never sees its errors — the capture is made by
// hand, in streamError() and in ndjsonStream's own catch. What has to hold is that
// the request's tags are still there when it fires: the producer re-enters through
// AsyncResource.bind and then re-opens the user scope (withUser) from scratch.
//
// An itest rather than a unit test because ndjsonStream opens a real transaction
// for the producer; the bind mechanism alone is covered in
// lib/observability/sentry.test.ts.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql } from "../../lib/db";
import { ndjsonStream } from "../../lib/http/ndjson";
import { streamError } from "../../lib/http/missingKeyServer";
import { flushSentry, setRequestTags } from "../../lib/observability/sentry";
import { initSentryInMemory, withRequestIsolation } from "../../lib/observability/testing";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;
type Event = { event_id: string; tags: Record<string, string>; exception: { values: { value: string }[] } };

const events = initSentryInMemory();
let admin: Sql;
let alice: { id: string; email: string };

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  alice = await createUser(admin);
  events.length = 0;
});

// withRequestConfig's shape: a request isolation scope, the user scope, then the
// config and route tags, then a handler that returns the stream straight away.
function request(run: Parameters<typeof ndjsonStream<{ type: string }>>[0]): Promise<Response> {
  return withRequestIsolation(() =>
    withUser(alice, async () => {
      setRequestTags({ configId: "cfg-itest", route: "/api/eval/process" });
      return ndjsonStream(run);
    }),
  );
}

// Drain the body: the producer only finishes once the stream is read to the end.
async function lines(res: Response): Promise<{ type: string; message?: string }[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("an error inside an ndjsonStream producer", () => {
  it("reported by the route's catch (streamError) carries config.id, user.id and route", async () => {
    const res = await request(async (send) => {
      try {
        throw new Error("producer failed after the handler returned");
      } catch (err) {
        send(streamError(err, "Scoring failed."));
      }
    });
    const body = await lines(res);
    assert.ok(await flushSentry());

    assert.equal(body.at(-1)?.type, "error");
    assert.equal(events.length, 1);
    const event = events[0] as Event;
    assert.equal(event.tags["config.id"], "cfg-itest");
    assert.equal(event.tags["user.id"], alice.id);
    assert.equal(event.tags.route, "/api/eval/process");
    assert.equal(event.tags.site, "ndjson");
    assert.equal(event.exception.values[0].value, "producer failed after the handler returned");
  });

  it("that escapes `run` is reported by ndjsonStream itself and ends the body with an error line", async () => {
    const res = await request(async () => {
      throw new Error("escaped the producer");
    });
    const body = await lines(res);
    assert.ok(await flushSentry());

    assert.deepEqual(body.at(-1), { type: "error", message: "escaped the producer" });
    assert.equal(events.length, 1);
    const event = events[0] as Event;
    assert.equal(event.tags["config.id"], "cfg-itest");
    assert.equal(event.tags["user.id"], alice.id);
    assert.equal(event.tags.site, "ndjson");
  });
});
