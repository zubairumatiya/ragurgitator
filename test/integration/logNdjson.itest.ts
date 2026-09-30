// THE LOG CONTEXT INSIDE A REAL ndjsonStream PRODUCER.
//
// ndjson.ts resets three of the scopes AsyncResource.bind restores and deliberately
// not the log context (lib/log.ts), so a producer's lines carry the handler's
// requestId, route and configId — and re-entering withUser from scratch must not
// lose them. The bind mechanism alone is covered in lib/log.test.ts.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql } from "../../lib/db";
import { ndjsonStream } from "../../lib/http/ndjson";
import { log, withLogContext } from "../../lib/log";
import { logLineSchema } from "../../lib/log.schema";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

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
});

describe("a line logged inside an ndjsonStream producer", () => {
  it("carries the handler's requestId, route, configId and userId", async () => {
    const cap = log.__capture();
    try {
      // withRequestConfig's shape: request context, user scope, config, then a
      // handler that returns the stream straight away.
      const res = await withLogContext({ requestId: "req-itest", route: "/api/eval" }, () =>
        withUser(alice, async () =>
          withLogContext({ configId: "cfg-itest" }, () =>
            ndjsonStream(async (send) => {
              await new Promise((r) => setTimeout(r, 5));
              log.warn("from the producer", { component: "itest" });
              send({ type: "done" });
            }),
          ),
        ),
      );
      log.info("between requests");
      await res.text();
    } finally {
      cap.stop();
    }

    const lines = cap.lines.map((l) => logLineSchema.parse(JSON.parse(l)));
    const line = lines.find((l) => l.msg === "from the producer");
    assert.ok(line, "the producer's line was captured");
    assert.equal(line.requestId, "req-itest");
    assert.equal(line.route, "/api/eval");
    assert.equal(line.configId, "cfg-itest");
    assert.equal(line.userId, alice.id);
    assert.equal(line.level, "warn");
    assert.equal(lines.find((l) => l.msg === "between requests")?.requestId, undefined);
  });
});
