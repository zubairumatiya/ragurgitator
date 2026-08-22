// Deletion behaves as promised, in both directions.
//
// scripts/cascade-check.ts asserts the same schema properties against the live
// project and stays for the pre/post-migration ritual. What it says outright it
// cannot do is observe the deletion:
//
//   "Neither can be checked by running the deletion — the first would have to
//    destroy a real key to prove nothing followed it, and the second cannot be
//    observed once the rows are gone."
//
// Both objections are about production. On a throwaway database, deleting a key
// and deleting an account are free, and this file therefore checks the thing the
// contract is actually about: what SURVIVES, and what does NOT.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof postgres>;

// The contract these tables encode: derived data the user has already paid for
// must outlive the deletion of the key that produced it.
const MUST_SURVIVE_KEY_DELETION = [
  "embedding_cache",
  "question_cache",
  "semantic_cache",
  "semantic_cache_thresholds",
  "document_embeddings",
];

let sql: Sql;

before(async () => {
  sql = adminClient();
  await ensureAppRole(sql);
  await truncateAll(sql);
});

after(async () => {
  await sql?.end();
});

async function seedOwnedRows(userId: string) {
  const [corpus] = await sql<{ id: string }[]>`
    insert into corpora (name, user_id) values ('c', ${userId}) returning id`;
  const [config] = await sql<{ id: string }[]>`
    insert into configs (corpus_id, name, base_model, chunk_size, chunk_overlap, top_k, llm_model, user_id)
    values (${corpus.id}, 'cfg', 'voyage-4-lite', 512, 64, 5, 'claude-sonnet-4-6', ${userId})
    returning id`;
  const [document] = await sql<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('d.txt', ${`h-${userId}`}, 'body', ${userId}) returning id`;
  await sql`insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${document.id})`;
  // embedding is float4[]. Two traps here, both hit on the way to this line:
  // a bracketed "[0,0,…]" is the VECTOR literal form and is rejected as a
  // malformed array, while sql.array() of JS numbers is sent as text[], which
  // real[] will not accept. A brace-delimited literal left untyped lets Postgres
  // resolve the parameter to the column's own type.
  const embedding = `{${Array.from({ length: 1024 }, () => 0).join(",")}}`;
  await sql`
    insert into embedding_cache (model, input_kind, text_hash, dimension, embedding, user_id)
    values ('voyage-4-lite', 'document', ${`t-${userId}`}, 1024, ${embedding}, ${userId})`;
  return { corpus: corpus.id, config: config.id, document: document.id };
}

describe("provider-key deletion", () => {
  it("nothing references user_provider_keys, so a key deletion cannot cascade", async () => {
    // deleteProviderKey issues one `delete from user_provider_keys`, so its
    // blast radius is exactly the set of FKs pointing at that table.
    const referencing = await sql<{ child: string }[]>`
      select child.relname as child
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_class parent on parent.oid = c.confrelid
      join pg_namespace n on n.oid = child.relnamespace
      where c.contype = 'f' and n.nspname = 'public' and parent.relname = 'user_provider_keys'`;
    assert.deepEqual(referencing.map((r) => r.child), []);
  });

  it("deleting a key really leaves the derived data behind", async () => {
    // The observation the script cannot make. Schema reachability says nothing
    // follows the key; this deletes one and counts what is still there.
    const user = await createUser(sql);
    await seedOwnedRows(user.id);
    // Envelope-encrypted columns are bytea, so they take a Buffer — a "\\x00"
    // string is sent as text and comes back as "insufficient data left in
    // message". The values are placeholders: this test is about what deletion
    // touches, not about the crypto.
    const blob = Buffer.from([0]);
    await sql`
      insert into user_provider_keys
        (user_id, provider, ciphertext, wrapped_dek, nonce, auth_tag, kek_id, last_four)
      values (${user.id}, 'voyage', ${blob}, ${blob}, ${blob}, ${blob}, 'test-kek', '1234')`;

    const before = await countAll(MUST_SURVIVE_KEY_DELETION);
    await sql`delete from user_provider_keys where user_id = ${user.id}`;
    const after = await countAll(MUST_SURVIVE_KEY_DELETION);

    assert.deepEqual(after, before, "deleting a provider key destroyed derived data");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from embedding_cache where user_id = ${user.id}`;
    assert.equal(n, 1, "the user's paid-for embeddings should have survived");

    await sql`delete from auth.users where id = ${user.id}`;
  });
});

async function countAll(tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const rows = (await sql.unsafe(`select count(*)::int as n from ${t}`)) as unknown as {
      n: number;
    }[];
    out[t] = rows[0].n;
  }
  return out;
}

describe("account deletion", () => {
  it("every table owned by a user is emptied by deleting the auth.users row", async () => {
    // `delete from auth.users` is the ONLY statement account deletion runs, so
    // anything not reachable from it by cascade is silently retained after the
    // user asked to be forgotten. The script proves reachability from the
    // catalog; this proves it by counting rows after the fact, which also covers
    // an edge that is reachable but points the wrong way.
    const doomed = await createUser(sql);
    const survivor = await createUser(sql);
    await seedOwnedRows(doomed.id);
    await seedOwnedRows(survivor.id);

    const tables = await ownedTables();
    const before = await countAll(tables);
    assert.ok(
      Object.values(before).some((n) => n > 0),
      "fixture seeded nothing — the assertion below would be vacuous",
    );

    await sql`delete from auth.users where id = ${doomed.id}`;

    // Not "everything is empty": the survivor's rows must still be there. A
    // cascade that took both would pass a naive emptiness check.
    for (const table of tables) {
      const rows = (await sql.unsafe(
        `select count(*)::int as n from ${table} where user_id = $1`,
        [doomed.id],
      )) as unknown as { n: number }[];
      assert.equal(rows[0].n, 0, `${table} retained rows for a deleted account`);
    }
    const [{ n: survivorRows }] = await sql<{ n: number }[]>`
      select count(*)::int as n from corpora where user_id = ${survivor.id}`;
    assert.ok(survivorRows > 0, "deleting one account destroyed another's data");

    await sql`delete from auth.users where id = ${survivor.id}`;
  });

  it("no public table is unreachable from an owner", async () => {
    // The catalog half, ported from the script. Its allowlist named the four
    // sub-topics tables, which have no migration and so do not exist here — so
    // the only exclusions this needs are the two tables that are SUPPOSED to
    // outlive every account.
    //
    // demo_provisions (0075) holds a salted IP hash and a timestamp for the
    // guest demo's rate limit. It is deliberately not linked to the guest it
    // created: if deleting the guest erased the record that an address minted
    // one, the limit would reset itself every time the reaper ran — which is
    // exactly the window an abuser would aim for. There is no personal data in
    // it for account deletion to be failing to collect.
    const orphans = await sql<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname not in ('schema_migrations', 'demo_provisions')
        and not exists (
          select 1 from pg_constraint fk
          where fk.contype = 'f' and fk.conrelid = c.oid and fk.confdeltype = 'c'
        )
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped
        )
      order by 1`;
    assert.deepEqual(
      orphans.map((r) => r.relname),
      [],
      "these tables have neither a cascading parent nor a user_id — nothing deletes them",
    );
  });
});

async function ownedTables(): Promise<string[]> {
  const rows = await sql<{ relname: string }[]>`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id'
      and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
    order by 1`;
  return rows.map((r) => r.relname);
}
