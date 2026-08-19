// Connects the integration tier to a throwaway Postgres, and seeds users in it.
//
// The database is NOT created here. It is provisioned outside the test process —
// a service container in CI, `npm run itest:up` on a laptop — and reached through
// TEST_DATABASE_URL. Tests that silently spin up infrastructure are slow, hide
// their own setup failures, and behave differently in the two places they run.
//
// SAFETY: every entry point refuses a URL that isn't local. The tier truncates
// tables and deletes users, so pointing it at the live project would destroy real
// data. That check is the only thing standing between a mistyped env var and a
// very bad afternoon, so it is unconditional and comes first.
import { after, before } from "node:test";

import postgres from "postgres";

import { sslFor } from "../../lib/dbSsl";

type Sql = ReturnType<typeof postgres>;

// The URL helpers and the local-only check live in dbUrls.ts so the env.ts
// preload can reach them without importing `node:test`. Re-exported here so
// tests keep a single import site.
export { appDatabaseUrl, assertLocal, testDatabaseUrl } from "./dbUrls";
import { APP_ROLE_PASSWORD, appDatabaseUrl, testDatabaseUrl } from "./dbUrls";

export function adminClient(): Sql {
  const url = testDatabaseUrl();
  // prepare: false mirrors production, where Supavisor forbids prepared
  // statements. A direct connection would allow them, and letting the two
  // diverge would mean the tier exercises a query path production never runs.
  return postgres(url, { prepare: false, ssl: sslFor(url), max: 4 });
}

export function appClient(): Sql {
  const url = appDatabaseUrl();
  return postgres(url, { prepare: false, ssl: sslFor(url), max: 4 });
}

// 0051 leaves rag_app password-less, so it cannot log in until something sets
// one. Idempotent, and the password never leaves this machine.
export async function ensureAppRole(sql: Sql) {
  await sql.unsafe(`alter role rag_app password '${APP_ROLE_PASSWORD}'`);
}

let userCounter = 0;

// Insert a user the way Supabase Auth does — into auth.users — and let 0046's
// trigger create the profile. Tests must not insert into user_profiles directly:
// the trigger and the cascade from auth.users are part of what is under test.
export async function createUser(sql: Sql): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `itest-${++userCounter}-${id.slice(0, 8)}@example.test`;
  await sql`insert into auth.users (id, email) values (${id}, ${email})`;
  return { id, email };
}

export async function deleteUser(sql: Sql, id: string) {
  await sql`delete from auth.users where id = ${id}`;
}

// Every table the app owns, emptied between tests that need a clean slate.
// Derived from the catalog rather than listed, so a new table is included the
// day it ships instead of the day someone remembers to add it here.
export async function truncateAll(sql: Sql) {
  const rows = await sql<{ name: string }[]>`
    select table_name as name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
      and table_name <> 'schema_migrations'
  `;
  if (rows.length === 0) return;
  // Quote each identifier — table names come from the catalog, but quoting is
  // what makes that safe to interpolate rather than merely likely to be safe.
  const list = rows.map((r) => `public."${r.name.replace(/"/g, '""')}"`).join(", ");
  await sql.unsafe(`truncate ${list} restart identity cascade`);
  // auth.users is outside `public` and so outside the sweep above, but it roots
  // the ownership graph — leaving it populated would leak users between tests.
  await sql`delete from auth.users`;
}

// Standard fixture: one admin handle, role ready, clean tables per file.
//
// NOT named useDatabase: eslint's react-hooks plugin treats any `use*` function
// called at module scope as a misplaced React Hook, and lints the whole repo.
//
// `readOnly` skips the truncate, for files that only assert on the SCHEMA. They
// have no data to isolate, and wiping the database on their way past would
// destroy a fixture another file is still using. The tier runs serially
// (--test-concurrency=1, one shared database), but "serial" only means the files
// do not interleave — it does not make a truncate any less destructive to
// whatever ran before.
export function connectDatabase(options: { readOnly?: boolean } = {}): { sql: () => Sql } {
  let sql: Sql;
  before(async () => {
    sql = adminClient();
    await ensureAppRole(sql);
    if (!options.readOnly) await truncateAll(sql);
  });
  after(async () => {
    await sql?.end();
  });
  return { sql: () => sql };
}
