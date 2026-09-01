// toJsonb, through a real jsonb column.
//
// The bug this guards against is invisible at every layer above the database.
// `${JSON.stringify(v)}::jsonb` inserts without error, and reads back a STRING
// whose contents are JSON — so the type annotation still says `Scope` and every
// field access is undefined, surfacing much later as an UNDEFINED_VALUE on some
// downstream insert or a `.map is not a function`. Two tables were already
// storing string scalars this way before anyone noticed (migration 0052).
//
// So there are two assertions here, not one: that the right helper round-trips,
// and that the wrong pattern is DETECTABLE — `jsonb_typeof` is the shape a guard
// or a migration can search for, and it only exists once a real column is
// involved.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql, sql } from "../../lib/db";
import { claimJob, createJob, getJob } from "../../lib/jobs/store";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };
let configId: string;

// Deliberately not flat: a nested object and an array are what actually break
// when the value arrives as a string scalar.
const SCOPE = { mode: "all", ids: [1, 2, 3], nested: { deep: true, label: "x" } };

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
  await truncateAll(admin);
  alice = await createUser(admin);
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('c', ${alice.id}) returning id`;
  const [config] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${alice.id}, ${corpus.id}, 'base', 500, 50, 5, 'llm') returning id`;
  configId = config.id;
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

async function typeOf(column: string, id: string): Promise<string> {
  const [row] = await admin<{ t: string }[]>`
    select jsonb_typeof(${admin(column)}) as t from background_jobs where id = ${id}`;
  return row.t;
}

describe("toJsonb round-trips", () => {
  it("stores an object as an object and reads it back as one", async () => {
    const job = await withUser(alice, async () => {
      const created = await createJob({
        kind: "rescore",
        configId,
        configLabel: "cfg",
        scope: SCOPE,
        cursor: { at: 0 },
        totalUnits: 3,
      });
      // Read back through the store's own path, not just the insert's RETURNING —
      // a value can survive the round trip in one and not the other.
      return getJob(created.id);
    });

    assert.ok(job);
    assert.equal(typeof job.scope, "object");
    assert.deepEqual(job.scope, SCOPE);
    assert.equal(await typeOf("scope", job.id), "object");
    assert.equal(await typeOf("cursor", job.id), "object");
  });

  it("makes the double-encoded form detectable as a string scalar", async () => {
    const id = await withUser(alice, async () => {
      // The wrong pattern, written out on purpose. This is what lib/db.ts's
      // toJsonb comment is describing, and it inserts perfectly happily.
      const [row] = await sql<{ id: string }[]>`
        insert into background_jobs
          (user_id, kind, config_id, config_label, scope, total_units, status)
        values
          (${alice.id}, 'rescore', ${configId}, 'cfg',
           ${JSON.stringify(SCOPE)}::jsonb, 3, 'queued')
        returning id`;
      return row.id;
    });

    // Not an error anywhere — just a different jsonb_typeof. That single word is
    // the whole difference between a working row and a row that breaks later,
    // somewhere else, in code that never touched this table.
    assert.equal(await typeOf("scope", id), "string");

    const [row] = await admin<{ scope: unknown }[]>`
      select scope from background_jobs where id = ${id}`;
    assert.equal(typeof row.scope, "string", "the read comes back as JSON text, not an object");
  });

  it("turns a null cursor into SQL NULL, not the jsonb 'null' literal", async () => {
    // Worth pinning because it is not what the call site reads like. createJob
    // passes `toJsonb(args.cursor ?? null)`, which looks like it stores a jsonb
    // value — but postgres.js's json(null) binds SQL NULL, so the column ends up
    // empty rather than holding the literal. The two are distinguishable in SQL
    // (`cursor is null` vs `cursor = 'null'::jsonb`), so a later query that
    // filters on one and not the other would silently disagree with this row.
    const job = await withUser(alice, async () =>
      createJob({
        kind: "autotune",
        configId,
        configLabel: "cfg",
        scope: {},
        totalUnits: 1,
      }),
    );

    const [row] = await admin<{ isNull: boolean; typ: string | null }[]>`
      select cursor is null as "isNull", jsonb_typeof(cursor) as typ
      from background_jobs where id = ${job.id}`;
    assert.equal(row.isNull, true);
    assert.equal(row.typ, null);

    // And it survives the read back as a JS null, which is what run() defaults
    // on. Read through the CLAIM, not getJob: since the JOB_COLUMNS split the
    // claim is the only reader that selects `cursor` at all, so it is the only
    // one that can tell a stored null from an absent column.
    const claimed = await withUser(alice, async () => claimJob(job.id, 60));
    assert.equal(claimed?.job.cursor, null);
  });
});
