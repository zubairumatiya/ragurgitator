// The schema replays onto an empty database.
//
// Until this existed, nothing had ever checked it: the README's instruction was
// "run the SQL files in migrations/ against your project", so the files had only
// ever been applied incrementally, by hand, to one live database. Two of them
// could not in fact replay — 0011 seeded a corpus even when there were no
// documents for it to hold, and 0049/0050 then refused to assign that orphan an
// owner — and neither could have been noticed any other way.
//
// This runs against the database the harness is pointed at, which the CI job and
// `npm run itest:up` both build by replaying. So the assertions here are about
// the RESULT of a replay that already happened, plus a re-run to prove the ledger
// makes it idempotent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { testDatabaseUrl, connectDatabase } from "../support/harness";

const db = connectDatabase({ readOnly: true });

describe("migrations", () => {
  it("every file in migrations/ is recorded as applied", async () => {
    const onDisk = readdirSync("migrations").filter((f) => f.endsWith(".sql"));
    const applied = await db.sql()<{ filename: string }[]>`
      select filename from schema_migrations
    `;
    const appliedNames = new Set(applied.map((r) => r.filename));
    const missing = onDisk.filter((f) => !appliedNames.has(f));
    assert.deepEqual(missing, [], `migrations on disk but not applied: ${missing.join(", ")}`);
    assert.equal(applied.length, onDisk.length);
  });

  it("re-running the migrator is a no-op", () => {
    // The ledger, not the SQL, is what makes this safe: most of these files
    // would error on a second run (duplicate column, duplicate table). A green
    // second pass proves the runner is skipping, which is what lets CI and a
    // laptop share one command.
    const out = execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl(), MIGRATE_BOOTSTRAP: "" },
      encoding: "utf8",
    });
    assert.match(out, /up to date/);
  });

  it("the three ownership roots exist and are NOT NULL", async () => {
    // 0049's whole purpose. If the backfill fix had loosened NOT NULL rather
    // than the orphan check, this is what would catch it.
    const rows = await db.sql()<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id'
        and table_name in ('corpora', 'configs', 'documents')
      order by table_name
    `;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.is_nullable, "NO", `${row.table_name}.user_id should be NOT NULL`);
    }
  });

  it("batch_jobs.user_id stays nullable", async () => {
    // Deliberate, per 0049: batch_jobs.config_id is `on delete set null`, so an
    // orphaned historical job has no path to an owner and the poller reads null
    // as "not mine". A well-meaning NOT NULL here would break that.
    const [row] = await db.sql()<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_jobs' and column_name = 'user_id'
    `;
    assert.equal(row.is_nullable, "YES");
  });

  it("the backfills that blocked a replay stay conditional", async () => {
    // THE BEHAVIOURAL PROOF OF THESE FIXES IS THE REPLAY ITSELF, not this test.
    // If 0011 seeds a corpus with no documents again, 0049 has an orphan it
    // cannot assign an owner, aborts, and CI's migrate step goes red before any
    // test runs. That is a better guard than anything assertable here.
    //
    // What is left worth pinning is the SHAPE, and it has to be pinned
    // statically. Re-executing the statements is not an option: each was written
    // against the schema as of its own migration, and 0049 later made
    // corpora.user_id NOT NULL — so 0011's insert is invalid against the schema
    // that exists once the replay has finished. A file read is the honest way to
    // check a property of a file.
    const configs = readFileSync("migrations/0011_configs.sql", "utf8");
    const corpusBackfill = configs.match(/insert into corpora[\s\S]*?;/)?.[0] ?? "";
    assert.match(
      corpusBackfill,
      /where exists/,
      "0011's corpus backfill must be conditional on there being documents to hold",
    );

    for (const file of ["0049_ownership.sql", "0050_cache_isolation.sql"]) {
      const body = readFileSync(`migrations/${file}`, "utf8");
      assert.match(
        body,
        /orphans\s*>\s*0/,
        `${file} must only demand an owner when there is data to own`,
      );
    }
  });

  it("pgvector and pgcrypto are installed", async () => {
    const rows = await db.sql()<{ extname: string }[]>`
      select extname from pg_extension where extname in ('vector', 'pgcrypto') order by 1
    `;
    assert.deepEqual(rows.map((r) => r.extname), ["pgcrypto", "vector"]);
  });
});
