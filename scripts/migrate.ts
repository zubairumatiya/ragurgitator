// Applies migrations/*.sql in order, once each, recording what it applied.
//
// The repo had no runner: the README said "run the SQL files in migrations/
// against your project", so the 72 files have only ever been applied
// INCREMENTALLY, BY HAND, TO ONE LIVE DATABASE. Nothing had ever proved they
// replay onto an empty one, which makes recovery-from-scratch an open question
// and makes integration testing impossible — a throwaway database has to be
// built from these files or it isn't testing this schema.
//
// The ledger is `schema_migrations`, keyed by filename. Against the live project
// the first run therefore looks like "apply everything again", which would be
// wrong — so a run against a database that already has the schema must be
// baselined first (--baseline), recording every file as applied without running
// it. Fresh databases need nothing.
//
//   npm run migrate                            # apply what's missing
//   npm run migrate -- --baseline              # record all as applied, run none
//   npm run migrate -- --baseline-through 0072 # record up to 0072, leave the rest pending
//   MIGRATE_BOOTSTRAP=test/sql                 # apply these files first (test auth shim)
//
// --baseline-through is the one to use on a database that was migrated by hand:
// a bare --baseline would also record the migrations that have NOT been applied
// there, which is a ledger that lies in the most expensive direction.
//
// Runs as the privileged role: migrations create roles, schemas and event
// triggers, none of which rag_app may do.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set.");

const baseline = process.argv.includes("--baseline");

// --baseline-through <n>: record every migration up to and including <n>, and
// leave the rest pending so a normal run applies them. <n> matches on the
// leading number, so "0072" and "0072_provider_key_usage.sql" both work.
const throughIndex = process.argv.indexOf("--baseline-through");
const throughArg =
  throughIndex >= 0
    ? (process.argv[throughIndex + 1] ??
      (() => {
        throw new Error("--baseline-through needs a migration to stop at, e.g. 0072");
      })())
    : undefined;
if (throughArg !== undefined && Number.isNaN(Number.parseInt(throughArg, 10))) {
  throw new Error(`--baseline-through: '${throughArg}' does not start with a migration number.`);
}
const throughNumber = throughArg === undefined ? undefined : Number.parseInt(throughArg, 10);
const bootstrapDir = process.env.MIGRATE_BOOTSTRAP;

const sql = postgres(url, { prepare: false, ssl: sslFor(url), max: 1 });

// Numeric, not lexicographic: plain sort puts 0100 before 0099's successor only
// by luck of zero-padding, and the padding is a convention no one enforces.
function ordered(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => {
      const na = Number.parseInt(a, 10);
      const nb = Number.parseInt(b, 10);
      if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
      return na - nb || a.localeCompare(b);
    });
}

async function main() {
  await sql`
    create table if not exists schema_migrations (
      filename    text        primary key,
      applied_at  timestamptz not null default now()
    )
  `;

  // The bootstrap dir is fixture SQL, not schema history, so it is applied
  // every run and never recorded. Its files are written idempotently.
  if (bootstrapDir && existsSync(bootstrapDir)) {
    for (const file of ordered(bootstrapDir)) {
      await sql.unsafe(readFileSync(join(bootstrapDir, file), "utf8"));
      console.log(`  bootstrap  ${file}`);
    }
  }

  const done = new Set(
    (await sql<{ filename: string }[]>`select filename from schema_migrations`).map(
      (r) => r.filename,
    ),
  );

  // REFUSE TO REPLAY OVER AN EXISTING SCHEMA. The live project predates this
  // runner and so has no ledger: an empty `schema_migrations` there does NOT
  // mean "nothing applied", it means "never tracked". Applying all 73 files to
  // it would be catastrophic, and the URL is one shell variable away from
  // pointing at it.
  //
  // So the ledger being empty is only believed when the database is too. The
  // deliberate path is --baseline, which records without running.
  if (done.size === 0 && !baseline && throughNumber === undefined) {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n
      from information_schema.tables
      where table_schema = 'public' and table_name <> 'schema_migrations'
    `;
    if (n > 0) {
      throw new Error(
        `Refusing to run: ${n} table(s) already exist in \`public\` but nothing is ` +
          "recorded in schema_migrations. This looks like a database that was " +
          "migrated by hand before this runner existed — applying every file to " +
          "it would be destructive.\n\n" +
          "If that is what this is, record the current state first:\n" +
          "  npm run migrate -- --baseline\n\n" +
          "If you meant to build a fresh database, point DATABASE_URL at an empty one.",
      );
    }
  }
  const files = ordered("migrations");
  const pending = files.filter((f) => !done.has(f));

  if (baseline || throughNumber !== undefined) {
    const toRecord =
      throughNumber === undefined
        ? pending
        : pending.filter((f) => Number.parseInt(f, 10) <= throughNumber);
    for (const filename of toRecord) {
      await sql`insert into schema_migrations (filename) values (${filename})`;
    }
    const rest = pending.length - toRecord.length;
    console.log(
      `baselined ${toRecord.length} migration(s) as already applied; ran none` +
        (rest > 0 ? `\n${rest} still pending — run \`npm run migrate\` to apply them` : ""),
    );
    return;
  }

  if (pending.length === 0) {
    console.log(`up to date — ${files.length} migration(s) applied`);
    return;
  }

  for (const filename of pending) {
    const body = readFileSync(join("migrations", filename), "utf8");
    // One transaction per file, so a failure leaves the ledger and the schema
    // agreeing with each other rather than half-applied.
    //
    // `sql.unsafe` is correct and not a shortcut: the file is developer-authored
    // DDL with no interpolation, and postgres.js's tagged template would try to
    // parameterise it. `simple: false` keeps multi-statement files working while
    // still reporting the failing statement.
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (filename) values (${filename})`;
      });
      console.log(`  applied    ${filename}`);
    } catch (error) {
      console.log(`  FAILED     ${filename}`);
      console.log(`             ${(error as Error).message}`);
      throw error;
    }
  }
  console.log(`\napplied ${pending.length} migration(s)`);
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    await sql.end();
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
