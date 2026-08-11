// ---------------------------------------------------------------------------
// Proves the two halves of the deletion contract (open question #4, resolved
// 2026-08-08):
//
//   1. Deleting a PROVIDER KEY destroys nothing else. Cached embeddings,
//      ingested chunks and semantic_cache rows are derived data the user already
//      paid for, and they survive.
//   2. Deleting an ACCOUNT destroys everything. `delete from auth.users` is the
//      only statement account deletion runs (app/account/actions.ts), so every
//      row a user owns has to be reachable from it by ON DELETE CASCADE or it is
//      silently retained after "delete my data".
//
// Both are properties of the SCHEMA, not of any code path, which is why this is
// a script against the live database rather than a unit test. Neither can be
// checked by running the deletion — the first would have to destroy a real key
// to prove nothing followed it, and the second cannot be observed at all once
// the rows are gone.
//
// The account-deletion half is a reachability walk, not a table list, so a
// future migration that adds an owned table is caught here even though this file
// never learns its name. That is the whole point: the failure mode is a table
// that keeps a deleted user's rows forever while every page still looks correct.
//
// Run it after any migration that adds a table or an ownership column, next to
// `npm run rls:check`.
//
//   Usage: node --env-file=.env.local --import tsx scripts/cascade-check.ts
// ---------------------------------------------------------------------------
import postgres from "postgres";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL must be set.");

// Reads pg_catalog and counts rows; never writes. The privileged role is right
// here for the same reason migrations use it — RLS would hide exactly the
// orphaned rows this is looking for.
const sql = postgres(adminUrl, { prepare: false, ssl: "require" });

// Tables that legitimately survive account deletion, with the reason. Asserted
// rather than printed, so a new unreachable table is a failure and not a line of
// output nobody reads.
const EXPECTED_UNREACHABLE: Record<string, string> = {
  // Live-only tables from the sub-topics specimen pipeline: no migration, no
  // reader on this branch, and no ownership path at all. They gain a user_id and
  // a policy on that branch, with their first reader. See 0051 §4.
  topics: "sub-topics branch, no ownership path yet",
  topic_specimens: "sub-topics branch, no ownership path yet",
  topic_centroids: "sub-topics branch, no ownership path yet",
  chunk_topics: "sub-topics branch, content-addressed by text_hash",
};

// The contract from open question #4, named explicitly. These must reach an
// owner (so account deletion gets them) while being unreachable from
// user_provider_keys (so key deletion does not).
const MUST_SURVIVE_KEY_DELETION = [
  "embedding_cache",
  "question_cache",
  "semantic_cache",
  "semantic_cache_thresholds",
  "document_embeddings",
];

type Fk = {
  child: string;
  parent: string;
  constraint: string;
  action: string;
  columns: string;
};

async function foreignKeys(): Promise<Fk[]> {
  return sql<Fk[]>`
    select
      child.relname   as child,
      parent.relname  as parent,
      c.conname       as constraint,
      c.confdeltype   as action,
      (select string_agg(a.attname, ', ' order by a.attnum)
         from pg_attribute a
        where a.attrelid = c.conrelid and a.attnum = any(c.conkey)) as columns
    from pg_constraint c
    join pg_class child  on child.oid  = c.conrelid
    join pg_class parent on parent.oid = c.confrelid
    join pg_namespace n  on n.oid = child.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
    order by 1, 2`;
}

async function main() {
  const fks = await foreignKeys();
  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.log(`  <-- ${msg}`);
  };

  // -- 1. Key deletion is inert ---------------------------------------------
  // deleteProviderKey (lib/auth/providerKeys.ts) issues one `delete from
  // user_provider_keys`. Its blast radius is therefore exactly the set of FKs
  // pointing AT that table, and the contract says that set is empty.
  console.log("1. provider-key deletion\n");
  const referencingKeys = fks.filter((f) => f.parent === "user_provider_keys");
  if (referencingKeys.length === 0) {
    console.log("   nothing references user_provider_keys — deletion cannot cascade.");
  } else {
    for (const f of referencingKeys) console.log(`   ${f.child}.${f.columns} -> ${f.parent}`);
    fail(`UNEXPECTED: ${referencingKeys.length} table(s) would follow a deleted key.`);
  }

  for (const table of MUST_SURVIVE_KEY_DELETION) {
    const exists = fks.some((f) => f.child === table) || (await tableExists(table));
    if (!exists) fail(`UNEXPECTED: ${table} does not exist — the contract names a ghost.`);
  }
  console.log(`   named survivors present: ${MUST_SURVIVE_KEY_DELETION.join(", ")}`);

  // -- 2. Account deletion is total -----------------------------------------
  // Walk outward from auth.users through cascading edges only. A non-cascading
  // FK is a dead end on purpose: `set null` keeps the row, `no action` would
  // make the delete ERROR rather than orphan, and both are worth naming.
  console.log("\n2. account deletion reachability\n");

  const [profileFk] = await sql<{ action: string }[]>`
    select c.confdeltype as action
    from pg_constraint c
    join pg_class child on child.oid = c.conrelid
    join pg_class parent on parent.oid = c.confrelid
    join pg_namespace pn on pn.oid = parent.relnamespace
    where c.contype = 'f' and child.relname = 'user_profiles' and pn.nspname = 'auth'`;
  if (profileFk?.action === "c") {
    console.log("   auth.users -> user_profiles: cascade");
  } else {
    fail(`UNEXPECTED: user_profiles does not cascade from auth.users (action=${profileFk?.action}).`);
  }

  const cascading = fks.filter((f) => f.action === "c");
  const reached = new Set<string>(["user_profiles"]);
  for (let added = true; added; ) {
    added = false;
    for (const f of cascading) {
      if (reached.has(f.parent) && !reached.has(f.child)) {
        reached.add(f.child);
        added = true;
      }
    }
  }

  const allTables = await sql<{ relname: string }[]>`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by 1`;

  const unreachable = allTables.map((t) => t.relname).filter((t) => !reached.has(t));
  console.log(`   reachable from user_profiles: ${reached.size} of ${allTables.length} tables`);

  for (const table of unreachable) {
    const why = EXPECTED_UNREACHABLE[table];
    console.log(`   ${table.padEnd(32)} ${why ?? "NO OWNERSHIP PATH"}`);
    if (!why) fail(`UNEXPECTED: ${table} retains rows after the owner is deleted.`);
  }

  // Non-cascading edges out of an owned table. A `set null` edge is NOT a bug by
  // itself — batch_jobs.config_id is deliberately one (0049) — because the child
  // rows still die with the account through their own user_id. It bites only
  // when the detached edge was the child's ONLY path to an owner, and that is
  // precisely what the reachability set above already answers, so these lines
  // are context for reading section 2 rather than assertions of their own.
  const softEdges = fks.filter((f) => f.action !== "c" && reached.has(f.parent));
  if (softEdges.length) {
    console.log("\n   non-cascading edges out of owned tables (child stays reachable):");
    for (const f of softEdges) {
      // 'n' = set null; 'a' / 'r' = no action / restrict, which makes the parent
      // delete ERROR instead of orphaning — a different failure, equally fatal
      // to a one-statement account deletion.
      const kind = f.action === "n" ? "set null" : "no action / restrict";
      const detached = f.action === "n" ? await countOrphans(f) : 0;
      const note = detached > 0 ? `, ${detached} row(s) currently detached` : "";
      console.log(`   ${`${f.child}.${f.columns} -> ${f.parent}`.padEnd(52)} ${kind}${note}`);
      if (f.action !== "n") {
        fail(`UNEXPECTED: ${f.constraint} would make account deletion ERROR, not cascade.`);
      }
    }
  }

  // -- 3. user_id columns with no FK at all ---------------------------------
  // The reachability walk only sees declared constraints, so a table that
  // carries a bare user_id column is invisible to it and to the cascade.
  console.log("\n3. ownership columns without a constraint\n");
  const bareOwners = await sql<{ relname: string; attname: string }[]>`
    select c.relname, a.attname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'user_id'
      and not exists (
        select 1 from pg_constraint fk
        where fk.contype = 'f' and fk.conrelid = c.oid and a.attnum = any(fk.conkey))
    order by 1`;
  if (bareOwners.length === 0) {
    console.log("   every user_id column is backed by a foreign key.");
  } else {
    for (const r of bareOwners) console.log(`   ${r.relname}.${r.attname}`);
    fail(`UNEXPECTED: ${bareOwners.length} user_id column(s) enforce and cascade nothing.`);
  }

  console.log(
    failures === 0
      ? "\nOK — keys delete alone, accounts delete everything."
      : `\nFAILED — ${failures} problem(s).`,
  );
  await sql.end();
  if (failures) process.exitCode = 1;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = ${table}`;
  return rows[0].n > 0;
}

// Rows whose FK column is already null — for a `set null` edge, what an earlier
// parent deletion left behind. Informational: these rows still reach an owner by
// their own user_id, or section 2 would have named their table.
async function countOrphans(fk: Fk): Promise<number> {
  if (fk.columns.includes(",")) return 0;
  const rows = (await sql.unsafe(
    `select count(*)::int as n from ${fk.child} where ${fk.columns} is null`,
  )) as unknown as { n: number }[];
  return rows[0].n;
}

main();
