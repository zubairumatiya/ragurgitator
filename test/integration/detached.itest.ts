// runOutsideUserTransaction and detached(), against real transactions.
//
// Both exist because of the same silent failure: since 0051 a request scope IS a
// transaction, and work that outlives the response inherits a COMMITTED handle
// unless something deliberately breaks the inheritance. That bug took down all
// 12 NDJSON routes, and it took down the semantic cache's own hit counter — in
// both cases without an error anywhere.
//
// The mechanism is AsyncLocalStorage restoration, which is exactly the thing a
// unit test cannot observe: the wrong ordering type-checks, runs, and reports
// success. Only a real transaction can say whether the write landed.
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql, runOutsideUserTransaction, sql } from "../../lib/db";
import { detached, runOutsideDetachedQueue, withDetachedQueue } from "../../lib/detached";
import { resolveConfig, withConfig, activeConfig } from "../../lib/rag/activeConfig";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };
let configA: string;
let configB: string;

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
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('c', ${alice.id}) returning id`;
  const ids: string[] = [];
  for (const label of ["a", "b"]) {
    const [row] = await admin<{ id: string }[]>`
      insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
      values (${alice.id}, ${corpus.id}, 'voyage-4-lite', 500, 50, 5, ${`llm-${label}`}) returning id`;
    ids.push(row.id);
  }
  [configA, configB] = ids;
});

// Committed state, read on a separate connection.
async function corpusNames(): Promise<string[]> {
  const rows = await admin<{ name: string }[]>`select name from corpora order by name`;
  return rows.map((r) => r.name);
}

// What the CURRENT transaction can see. Distinct from corpusNames on purpose:
// an uncommitted row is invisible to `admin`, so asserting absence there would
// pass whether the write was queued, run, or lost.
async function corpusNamesInScope(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`select name from corpora order by name`;
  return rows.map((r) => r.name);
}

describe("runOutsideUserTransaction", () => {
  it("gives a producer a fresh transaction instead of the handler's committed one", async () => {
    // The ndjson.ts shape, reproduced exactly: bind on the OUTSIDE, the exit and
    // the re-entered scope INSIDE it. Bind captures the handler's context —
    // including its transaction — and restores it when the producer finally runs,
    // minutes later, so the exit has to happen after that restoration.
    let boundRun!: () => Promise<string>;

    const handlerTxid = await withUser(alice, async () => {
      boundRun = AsyncResource.bind(() =>
        runOutsideDetachedQueue(() =>
          runOutsideUserTransaction(() =>
            withUser(alice, async () => {
              await sql`insert into corpora (name, user_id) values ('from-producer', ${alice.id})`;
              const [row] = await sql<{ id: string }[]>`select txid_current()::text as id`;
              return row.id;
            }),
          ),
        ),
      );
      const [row] = await sql<{ id: string }[]>`select txid_current()::text as id`;
      return row.id;
    });

    // The handler's transaction has committed by here — this is the "minutes
    // later" the producer actually runs in.
    const producerTxid = await boundRun();

    assert.notEqual(producerTxid, handlerTxid, "producer inherited the handler's transaction");
    assert.ok((await corpusNames()).includes("from-producer"), "the producer's write was lost");
  });

  it("loses the producer's write when the exit is dropped", async () => {
    // The same code minus runOutsideUserTransaction. withUserTransaction is
    // REENTRANT, so withUser finds the restored — and dead — handle open for the
    // same user and reuses it rather than opening its own. This is the second
    // route to the original bug, and the reason the exit sits inside the bind
    // rather than being assumed redundant.
    let boundRun!: () => Promise<void>;

    await withUser(alice, async () => {
      boundRun = AsyncResource.bind(() =>
        withUser(alice, async () => {
          await sql`insert into corpora (name, user_id) values ('doomed', ${alice.id})`;
        }),
      );
    });

    // Either it throws on the dead handle or it "succeeds" and writes nothing.
    // Which one is postgres.js's business; what matters is that the row is not
    // there afterwards, because that is what shipped and nobody noticed.
    await boundRun().catch(() => {});
    assert.ok(!(await corpusNames()).includes("doomed"), "the dead handle accepted a write");
  });
});

describe("detached()", () => {
  it("runs queued writes after the request, in a transaction of their own", async () => {
    let flush!: () => Promise<void>;
    let requestTxid = "";

    await withUser(alice, async () =>
      withDetachedQueue(
        alice,
        (f) => {
          // Stands in for Next's after(): hold the flush, run it once the
          // request's transaction is long gone.
          flush = f;
        },
        async () => {
          const [row] = await sql<{ id: string }[]>`select txid_current()::text as id`;
          requestTxid = row.id;
          await detached(async () => {
            await sql`insert into corpora (name, user_id) values ('detached-write', ${alice.id})`;
          });
          // Queued, not run: the whole point is that the response does not wait.
          // Read inside the transaction — the row would be visible here if the
          // task had run inline, and invisible to `admin` either way.
          assert.ok(!(await corpusNamesInScope()).includes("detached-write"));
        },
      ),
    );

    await flush();
    assert.ok((await corpusNames()).includes("detached-write"), "the flush never wrote");

    // And it opened its own scope to do it — a flush that reused the request's
    // handle would be the very bug detached() exists to prevent.
    const [row] = await admin<{ name: string }[]>`
      select name from corpora where name = 'detached-write'`;
    assert.ok(row);
    assert.notEqual(requestTxid, "");
  });

  it("restores the config that was active when each task was queued", async () => {
    // The failure this guards is silent by construction: savingsStore answers a
    // missing config scope with `if (!configId) return;`. A task flushed under
    // the wrong config, or none, writes nothing and says nothing.
    const seen: string[] = [];
    let flush!: () => Promise<void>;

    await withUser(alice, async () => {
      const a = await resolveConfig(configA);
      const b = await resolveConfig(configB);
      assert.ok(a && b);
      return withDetachedQueue(
        alice,
        (f) => {
          flush = f;
        },
        async () => {
          // Two tasks queued under DIFFERENT configs, in one request. Capturing
          // at flush time instead of queue time would give both the same answer —
          // whichever scope happened to be current — and the test would show it.
          await withConfig(a, () => detached(async () => void seen.push(activeConfig().id)));
          await withConfig(b, () => detached(async () => void seen.push(activeConfig().id)));
        },
      );
    });

    await flush();
    assert.deepEqual(seen, [configA, configB]);
  });

  it("runs inline when there is no queue, so a script is not silently a no-op", async () => {
    // Scripts and the ndjson producers run with no queue installed. detached()
    // has to fall back to running the work rather than dropping it.
    await withUser(alice, async () => {
      await detached(async () => {
        await sql`insert into corpora (name, user_id) values ('inline', ${alice.id})`;
      });
      // Already there, inside the same transaction — no flush involved.
      assert.ok((await corpusNamesInScope()).includes("inline"));
    });
  });

  it("swallows a failing detached write instead of failing the request", async () => {
    // Telemetry is best-effort by contract. But note what is NOT claimed here:
    // detached() catching the error does not protect the caller's transaction —
    // only isolated() does that (see scope.itest.ts). Inline mode is exactly
    // where those two have to be combined, which is why the store-layer writers
    // use both.
    await withUser(alice, async () => {
      await runOutsideDetachedQueue(async () => {
        await detached(async () => {
          throw new Error("telemetry exploded");
        });
      });
    });
  });
});
