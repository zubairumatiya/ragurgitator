// The per-scope memo and the end-of-scope hook (lib/db.ts, cut 2 of
// docs/autotune-press-latency-plan.md §9), against real transactions.
//
// What a unit test cannot observe is exactly what these exist for: whether a
// second read in the same transaction went to the database, whether a savepoint
// that rolled back took its memoised reads with it, and whether a buffered
// ledger increment landed as one row with the right sum — before commit, so it
// commits with the work it describes.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import {
  fragment,
  isolated,
  privilegedSql,
  scopeAtEnd,
  scopeForget,
  scopeMemo,
  scopeRunNow,
  sql,
  withEfSearch,
} from "../../lib/db";
import { recordSaving, recordSpend } from "../../lib/rag/savingsStore";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };
let configA: string;

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
  const [row] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${alice.id}, ${corpus.id}, 'voyage-4-lite', 500, 50, 5, 'llm') returning id`;
  configA = row.id;
});

describe("scopeMemo", () => {
  it("asks once per scope, again after scopeForget, and afresh in the next scope", async () => {
    let reads = 0;
    const read = () =>
      scopeMemo("t:key", async () => {
        reads += 1;
        const [r] = await sql<{ n: number }[]>`select ${reads}::int as n`;
        return r.n;
      });

    const inFirst = await withUser(alice, async () => {
      const a = await read();
      const b = await read();
      scopeForget("t:");
      const c = await read();
      return [a, b, c];
    });
    assert.deepEqual(inFirst, [1, 1, 2]);
    assert.equal(reads, 2);

    await withUser(alice, read);
    assert.equal(reads, 3, "a new scope is a new memo");
  });

  it("is a pass-through outside a scope", async () => {
    let reads = 0;
    const read = () => scopeMemo("t:key", async () => (reads += 1));
    assert.equal(await read(), 1);
    assert.equal(await read(), 2);
  });

  it("forgets everything when a savepoint rolls back", async () => {
    let reads = 0;
    const read = () => scopeMemo("t:key", async () => (reads += 1));
    await withUser(alice, async () => {
      assert.equal(await read(), 1);
      await assert.rejects(
        isolated(async () => {
          assert.equal(await read(), 1, "shared with the savepoint scope");
          await sql`select 1 / 0`;
        }),
      );
      assert.equal(await read(), 2, "re-read after the rollback");
    });
  });

  it("does not memoise a rejection", async () => {
    let calls = 0;
    const read = () =>
      scopeMemo("t:key", async () => {
        calls += 1;
        if (calls === 1) throw new Error("first");
        return calls;
      });
    await withUser(alice, async () => {
      await assert.rejects(read(), /first/);
      assert.equal(await read(), 2);
    });
  });
});

describe("scopeAtEnd", () => {
  it("runs once per key, inside the transaction, before commit", async () => {
    const seen: string[] = [];
    await withUser(alice, async () => {
      await scopeAtEnd("t:hook", async () => {
        const [r] = await sql<{ id: string }[]>`select txid_current()::text as id`;
        seen.push(`ran in ${r.id}`);
        await sql`insert into corpora (name, user_id) values ('from-hook', ${alice.id})`;
      });
      await scopeAtEnd("t:hook", async () => {
        seen.push("second registration ran");
      });
      seen.push("body done");
    });
    assert.deepEqual(seen, ["body done", "ran in " + seen[1].slice(7)]);
    const rows = await admin<{ name: string }[]>`select name from corpora where name = 'from-hook'`;
    assert.equal(rows.length, 1, "the hook's write committed with the scope");
  });

  it("scopeRunNow runs a hook early and it does not run again", async () => {
    let runs = 0;
    await withUser(alice, async () => {
      await scopeAtEnd("t:hook", async () => {
        runs += 1;
      });
      await scopeRunNow("t:hook");
      assert.equal(runs, 1);
    });
    assert.equal(runs, 1);
  });

  it("runs immediately outside a scope", async () => {
    let runs = 0;
    await scopeAtEnd("t:hook", async () => {
      runs += 1;
    });
    assert.equal(runs, 1);
  });
});

describe("buffered savings and spend", () => {
  const totals = async () =>
    admin<{ lever: string; event_count: string; tokens_saved: string; saved_usd: string }[]>`
      select lever, event_count::text, tokens_saved::text, saved_usd::text
      from savings_totals where config_id = ${configA} order by lever`;

  it("lands as one summed row per lever at the end of the scope", async () => {
    await withUser(alice, async () => {
      await recordSaving("embed_cache", 0.5, 100, { events: 2, configId: configA });
      await recordSaving("embed_cache", 0.25, 50, { events: 1, configId: configA });
      await recordSaving("question_reuse", 1, 10, { configId: configA });
      await recordSpend("embed", 0.125, 30, { configId: configA });
      // Nothing written yet: the buffer holds it.
      const [n] = await sql<{ n: string }[]>`
        select count(*)::text as n from savings_totals where config_id = ${configA}`;
      assert.equal(n.n, "0");
    });
    const rows = await totals();
    assert.deepEqual(
      rows.map((r) => [r.lever, r.event_count, r.tokens_saved, Number(r.saved_usd)]),
      [
        ["embed_cache", "3", "150", 0.75],
        ["question_reuse", "1", "10", 1],
      ],
    );
    const [spend] = await admin<{ tokens: string; spent_usd: string }[]>`
      select tokens::text, spent_usd::text from spend_totals where config_id = ${configA} and surface = 'embed'`;
    assert.deepEqual([spend.tokens, Number(spend.spent_usd)], ["30", 0.125]);
  });

  it("adds to an existing row across scopes", async () => {
    await withUser(alice, () => recordSaving("embed_cache", 1, 10, { configId: configA }));
    await withUser(alice, () => recordSaving("embed_cache", 1, 10, { configId: configA }));
    const rows = await totals();
    assert.deepEqual(rows.map((r) => [r.event_count, r.tokens_saved]), [["2", "20"]]);
  });

});

describe("withEfSearch", () => {
  it("sets the GUC once per scope and the query sees it", async () => {
    const v = await withUser(alice, async () => {
      const a = await withEfSearch(100, (tx) => tx<{ v: string }[]>`select current_setting('hnsw.ef_search') as v`);
      const b = await withEfSearch(100, (tx) => tx<{ v: string }[]>`select current_setting('hnsw.ef_search') as v`);
      const c = await withEfSearch(120, (tx) => tx<{ v: string }[]>`select current_setting('hnsw.ef_search') as v`);
      return [a[0].v, b[0].v, c[0].v];
    });
    assert.deepEqual(v, ["100", "100", "120"]);
  });

  it("turns on iterative scan alongside it, so a config filter cannot starve the top-k", async () => {
    const v = await withUser(alice, async () => {
      const r = await withEfSearch(100, (tx) => tx<{ v: string }[]>`select current_setting('hnsw.iterative_scan') as v`);
      return r[0].v;
    });
    assert.equal(v, "strict_order");
  });

  it("re-sets after a rolled-back savepoint undid it", async () => {
    const v = await withUser(alice, async () => {
      await assert.rejects(
        isolated(async () => {
          await withEfSearch(100, (tx) => tx`select 1`);
          await sql`select 1 / 0`;
        }),
      );
      const r = await withEfSearch(100, (tx) => tx<{ v: string }[]>`select current_setting('hnsw.ef_search') as v`);
      return r[0].v;
    });
    assert.equal(v, "100");
  });
});
