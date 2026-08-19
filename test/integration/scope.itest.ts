// The scope machinery in lib/db.ts, against a real transaction.
//
// Every assertion here is about something Postgres does, not about something a
// function returns: whether `set local` really dies with its transaction,
// whether a savepoint really contains a failure, whether `sql.begin` really
// opens a savepoint rather than a transaction. A unit test can only check that
// the code calls the API it appears to call — which is exactly the level at
// which all three of these have been wrong before.
//
// SAFETY: this file imports lib/db.ts, so it connects with DATABASE_URL and
// RAG_APP_DATABASE_URL rather than the harness's own clients. test/support/env.ts
// derives both from TEST_DATABASE_URL before this module loads; see the note
// there for why that has to be a --import preload.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, isolated, privilegedSql, sql } from "../../lib/db";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };
let bob: { id: string; email: string };

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
  await truncateAll(admin);
  alice = await createUser(admin);
  bob = await createUser(admin);
});

after(async () => {
  await admin?.end();
  // `fragment` IS the app pool (lib/db.ts), so ending it closes the connections
  // the scopes ran on. Without this the runner hangs on an idle pool.
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

async function corpusNames(): Promise<string[]> {
  const rows = await admin<{ name: string }[]>`select name from corpora order by name`;
  return rows.map((r) => r.name);
}

describe("scope and transaction semantics", () => {
  it("refuses a nested scope for a second user", async () => {
    await assert.rejects(
      withUser(alice, async () => {
        await withUser(bob, async () => "unreachable");
      }),
      /nested scope for user/,
    );
  });

  it("reuses the open transaction for a nested scope for the same user", async () => {
    const [outer, inner] = await withUser(alice, async () => {
      const [a] = await sql<{ id: string }[]>`select txid_current()::text as id`;
      const [b] = await withUser(alice, async () => {
        return [await sql<{ id: string }[]>`select txid_current()::text as id`];
      });
      return [a.id, b[0].id];
    });
    // A second transaction would have a different id — and, more to the point,
    // would be a second connection with its own identity to keep in step.
    assert.equal(inner, outer);
  });

  it("sets the identity as `set local`, so it dies with the transaction", async () => {
    const pid = await withUser(alice, async () => {
      const [row] = await sql<{ pid: number; uid: string }[]>`
        select pg_backend_pid() as pid, current_setting('app.user_id', true) as uid`;
      assert.equal(row.uid, alice.id);
      return row.pid;
    });

    // `fragment` is the bare pool: no transaction, no GUC set. So a query on it
    // that lands on the SAME backend the scope just released is the leak test —
    // had the scope used `set` rather than `set local`, alice's id would still be
    // sitting on that connection waiting for the next tenant.
    const seen: (string | null)[] = [];
    for (let i = 0; i < 20; i++) {
      const [row] = await fragment<{ pid: number; uid: string | null }[]>`
        select pg_backend_pid() as pid, current_setting('app.user_id', true) as uid`;
      if (row.pid === pid) seen.push(row.uid);
    }
    assert.ok(seen.length > 0, `never landed back on backend ${pid}; pool reuse assumption broken`);
    for (const uid of seen) {
      assert.ok(uid === null || uid === "", `app.user_id leaked past its transaction: ${uid}`);
    }
  });

  it("isolated() keeps a failed best-effort write from aborting the request", async () => {
    await withUser(alice, async () => {
      await sql`insert into corpora (name, user_id) values ('before', ${alice.id})`;
      // Stands in for any best-effort write — a spend row, a usage row — whose
      // contract is "record it if you can, carry on if you can't".
      await assert.rejects(isolated(async () => sql`select 1 / 0`), /division by zero/);
      // The point of the savepoint: the transaction is still usable here.
      await sql`insert into corpora (name, user_id) values ('after', ${alice.id})`;
    });

    assert.deepEqual(await corpusNames(), ["after", "before"]);
  });

  it("without isolated(), the same failure takes the whole scope down", async () => {
    await truncateAll(admin);
    alice = await createUser(admin);

    await assert.rejects(
      withUser(alice, async () => {
        await sql`insert into corpora (name, user_id) values ('doomed', ${alice.id})`;
        // Caught at the call site, and caught too late: postgres.js records the
        // rejection and rethrows it after the callback returns, and Postgres has
        // already aborted the transaction regardless of who caught what.
        try {
          await sql`select 1 / 0`;
        } catch {
          // deliberately swallowed — this is the pattern isolated() exists to fix
        }
      }),
    );

    // The write before the failure is gone too. That is the blast radius 0051
    // introduced, and the reason every best-effort write goes through isolated().
    assert.deepEqual(await corpusNames(), []);
  });

  it("maps sql.begin onto a savepoint rather than a new transaction", async () => {
    await truncateAll(admin);
    alice = await createUser(admin);

    await withUser(alice, async () => {
      const [outer] = await sql<{ id: string }[]>`select txid_current()::text as id`;
      await sql`insert into corpora (name, user_id) values ('outer', ${alice.id})`;

      const inner = await sql.begin(async (tx) => {
        return [await tx<{ id: string }[]>`select txid_current()::text as id`];
      });
      // Same transaction id: a real `begin` on a fresh connection could not
      // report this one. The Proxy in lib/db.ts is what makes this true — a
      // postgres.js transaction handle has no `begin` to forward to.
      assert.equal((inner as unknown as { id: string }[][])[0][0].id, outer.id);

      // And it rolls back like a savepoint: its own writes go, the enclosing
      // transaction survives to commit.
      await assert.rejects(
        sql.begin(async (tx) => {
          await tx`insert into corpora (name, user_id) values ('inner', ${alice.id})`;
          throw new Error("boom");
        }),
        /boom/,
      );

      await sql`insert into corpora (name, user_id) values ('last', ${alice.id})`;
    });

    assert.deepEqual(await corpusNames(), ["last", "outer"]);
  });
});
