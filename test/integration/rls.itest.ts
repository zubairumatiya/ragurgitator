// RLS isolation, as a PARTITION over a seeded two-tenant fixture.
//
// scripts/rls-check.ts makes the same central assertion against the live
// project, and stays for use before and after a migration. What it cannot do is
// what this file does: build the fixture. Running against real data it has to
// bracket every count between two admin reads, because a page load landing
// mid-sweep would otherwise read as a policy failure — and it can never assert
// the interesting negative cases, because creating a policy-less table or a
// second tenant's row in production is not on the table.
//
// Here the truth is known exactly: two users, a fixed number of rows each,
// nothing else writing. So the assertions are equalities, not ranges.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import { sslFor } from "../../lib/dbSsl";
import {
  adminClient,
  appDatabaseUrl,
  createUser,
  ensureAppRole,
  truncateAll,
} from "../support/harness";

type Sql = ReturnType<typeof postgres>;

const STRANGER = "00000000-0000-0000-0000-0000000000ff";

// One representative table per shape in the ownership graph — owner-rooted,
// config-rooted, document-rooted and join-table — mirroring the script's list
// minus the tables this fixture does not populate.
const PROBES = ["corpora", "configs", "documents", "user_profiles", "corpus_documents"];

let admin: Sql;
let app: Sql;
let alice: { id: string; email: string };
let bob: { id: string; email: string };

// Rows seeded per user, so every expected count below is a stated number rather
// than a query that could be wrong in the same way the code is.
const PER_USER = { corpora: 2, configs: 3, documents: 2, user_profiles: 1, corpus_documents: 2 };

async function countAs(userId: string | null, table: string): Promise<number> {
  const rows = await app.begin(async (tx) => {
    if (userId) await tx`select set_config('app.user_id', ${userId}, true)`;
    return [await tx.unsafe(`select count(*)::int as n from ${table}`)];
  });
  return (rows as unknown as { n: number }[][])[0][0].n;
}

async function seedFor(user: { id: string }) {
  const corpora: string[] = [];
  for (let i = 0; i < PER_USER.corpora; i++) {
    const [row] = await admin<{ id: string }[]>`
      insert into corpora (name, user_id) values (${`corpus-${i}`}, ${user.id}) returning id`;
    corpora.push(row.id);
  }
  for (let i = 0; i < PER_USER.configs; i++) {
    await admin`
      insert into configs (corpus_id, name, base_model, chunk_size, chunk_overlap, top_k, llm_model, user_id)
      values (${corpora[0]}, ${`config-${i}`}, 'voyage-4-lite', 512, 64, 5, 'claude-sonnet-4-6', ${user.id})`;
  }
  const documents: string[] = [];
  for (let i = 0; i < PER_USER.documents; i++) {
    const [row] = await admin<{ id: string }[]>`
      insert into documents (file_name, content_hash, content, user_id)
      values (${`doc-${i}.txt`}, ${`hash-${user.id}-${i}`}, 'body', ${user.id}) returning id`;
    documents.push(row.id);
  }
  for (const documentId of documents) {
    await admin`
      insert into corpus_documents (corpus_id, document_id) values (${corpora[0]}, ${documentId})`;
  }
}

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
  await truncateAll(admin);
  const url = appDatabaseUrl();
  app = postgres(url, { prepare: false, ssl: sslFor(url), max: 3 });
  alice = await createUser(admin);
  bob = await createUser(admin);
  await seedFor(alice);
  await seedFor(bob);
});

after(async () => {
  await app?.end();
  await admin?.end();
});

describe("RLS", () => {
  it("connects as a role that cannot bypass RLS", async () => {
    // If this is wrong every other assertion in the file is vacuous, so it runs
    // first. It is exactly the mistake lib/db.ts refuses to let happen silently.
    const [role] = await app<{ current_user: string; bypassrls: boolean }[]>`
      select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`;
    assert.equal(role.current_user, "rag_app");
    assert.equal(role.bypassrls, false);
  });

  for (const table of PROBES) {
    it(`${table}: each user sees exactly their own rows, and they sum to the total`, async () => {
      const expected = PER_USER[table as keyof typeof PER_USER];
      const [{ n: total }] = (await admin.unsafe(
        `select count(*)::int as n from ${table}`,
      )) as unknown as { n: number }[];

      const asAlice = await countAs(alice.id, table);
      const asBob = await countAs(bob.id, table);

      assert.equal(asAlice, expected, `alice should see ${expected} ${table}`);
      assert.equal(asBob, expected, `bob should see ${expected} ${table}`);
      // The partition itself: too tight leaves rows nobody can read, too loose
      // shows one row to both. Only equality rules out both at once.
      assert.equal(asAlice + asBob, total, `${table} is not partitioned by owner`);
    });

    it(`${table}: a stranger and an unidentified connection see nothing`, async () => {
      assert.equal(await countAs(STRANGER, table), 0, `a stranger read ${table}`);
      assert.equal(await countAs(null, table), 0, `an unidentified connection read ${table}`);
    });
  }

  it("writing another user's row is rejected", async () => {
    // The read side can be right while WITH CHECK is missing, and the failure is
    // silent in the other direction: a row written under the wrong owner simply
    // vanishes from its author's view.
    await assert.rejects(
      () =>
        app.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${alice.id}, true)`;
          await tx`
            insert into corpora (name, user_id) values ('smuggled', ${bob.id})`;
          return [];
        }),
      /row-level security|violates/i,
      "alice was able to insert a corpus owned by bob",
    );
  });

  it("updating another user's row affects nothing", async () => {
    const updated = await app.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${alice.id}, true)`;
      const rows = await tx`
        update corpora set name = 'hijacked' where user_id = ${bob.id} returning id`;
      return [rows];
    });
    assert.equal((updated as unknown as unknown[][])[0].length, 0);
  });

  it("every public table has a policy", async () => {
    // A table with RLS on and no policy is deny-all to rag_app: empty reads,
    // rejected writes, no error anywhere. 0051's event trigger turns RLS on for
    // every new table automatically, but policies have no such mechanism, so
    // this is the check that a new migration did not ship half of the pair.
    //
    // The live database also holds four policy-less tables from the sub-topics
    // branch (0051 §4) — they have no migration, so they do not exist here.
    //
    // demo_provisions (0075) is the one deliberate exception, and it is deny-all
    // ON PURPOSE: it is read and written only through privilegedSql, holds no
    // tenant's data (a salted IP hash and a timestamp), and there is no user it
    // could be scoped to — the visitor it rate-limits has no account yet. A
    // policy would have to invent an owner in order to grant one.
    const policyless = await admin<{ relname: string }[]>`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname not in ('schema_migrations', 'demo_provisions')
        and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
      order by 1`;
    assert.deepEqual(
      policyless.map((r) => r.relname),
      [],
      "these tables are unreachable to the app until they get a policy",
    );
  });

  it("a policy-less table really is invisible, not merely unlisted", async () => {
    // Proves the check above is worth making: without it, the failure it guards
    // produces no error of any kind.
    await admin`create table if not exists rls_probe (id int primary key, user_id uuid)`;
    await admin`grant select, insert on rls_probe to rag_app`;
    await admin`insert into rls_probe (id, user_id) values (1, ${alice.id}) on conflict do nothing`;
    try {
      const [{ n }] = (await admin.unsafe(
        "select count(*)::int as n from rls_probe",
      )) as unknown as { n: number }[];
      assert.equal(n, 1, "admin should see the seeded row");
      assert.equal(
        await countAs(alice.id, "rls_probe"),
        0,
        "a table with RLS on and no policy should be deny-all — this is the silent failure",
      );
    } finally {
      await admin`drop table if exists rls_probe`;
    }
  });
});
