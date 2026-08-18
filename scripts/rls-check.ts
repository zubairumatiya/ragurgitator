// Proves that 0051's policies are actually load-bearing, by trying to read data as
// `rag_app` under three identities: every real user, a stranger, and nobody.
//
// The per-table assertion is a partition: every user's view summed together must
// equal what admin sees. A policy that is too tight leaves rows no user can read
// (sum below the total), and one that is too loose shows a row to two users (sum
// above it). Summing rather than comparing one user against the global count is
// what makes this survive a second account — the old check asserted that the
// first user saw every row in the database, which stopped being true the moment
// anyone else signed up.
//
// A script rather than a one-off, because the failure mode it guards is silent in
// both directions. A policy that is too tight makes a feature return empty rather
// than error, and a policy that is missing makes a table readable by everyone while
// every page still looks correct — neither shows up in a typecheck, a unit test, or
// a page that only ever renders one account's data.
//
// Run it after any migration that adds a table or changes an ownership column.
//
//   Usage: node --env-file=.env.local --import tsx scripts/rls-check.ts
import postgres from "postgres";

const appUrl = process.env.RAG_APP_DATABASE_URL;
const adminUrl = process.env.DATABASE_URL;
if (!appUrl || !adminUrl) {
  throw new Error("Both DATABASE_URL and RAG_APP_DATABASE_URL must be set.");
}

const admin = postgres(adminUrl, { prepare: false, ssl: "require" });
const app = postgres(appUrl, { prepare: false, ssl: "require", max: 3 });

const STRANGER = "00000000-0000-0000-0000-0000000000ff";

// One representative table per shape in the ownership graph, so a new table that
// forgot its policy is caught by the count check below rather than by this list.
const PROBES = [
  "configs",
  "documents",
  "corpora",
  "embedding_cache",
  "question_cache",
  "user_profiles",
  "chunks_voyage_4_lite_1024",
  "document_embeddings",
  "semantic_cache",
  "eval_questions",
  "eval_results",
  "corpus_documents",
  "chunk_clusters",
];

async function countAs(userId: string | null, table: string): Promise<number | string> {
  try {
    const rows = await app.begin(async (tx) => {
      if (userId) await tx`select set_config('app.user_id', ${userId}, true)`;
      return [await tx.unsafe(`select count(*)::int as n from ${table}`)];
    });
    return (rows as unknown as { n: number }[][])[0][0].n;
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

async function main() {
  // Every user, because the check below is a sum over all of them; ordered so the
  // first row is the same "owner" the script has always reported.
  const users = await admin<{ id: string }[]>`
    select id from user_profiles order by created_at`;
  if (!users.length) throw new Error("No user_profiles rows — nothing to check.");
  console.log(`users   = ${users.length} (owner ${users[0].id})`);
  console.log(`stranger= ${STRANGER}\n`);

  console.log("table                          admin      per-user  stranger  no-identity");
  console.log("-".repeat(80));

  let failures = 0;
  const adminCount = async (table: string) => {
    const rows = (await admin.unsafe(
      `select count(*)::int as n from ${table}`,
    )) as unknown as { n: number }[];
    return rows[0].n;
  };

  for (const table of PROBES) {
    // Bracket the per-user sweep with two admin reads rather than comparing
    // against one. This script is meant to be run against a LIVE app, and
    // embedding_cache / savings_totals / spend_totals get written on almost any
    // activity — so a single before-count races every page load and reports a
    // failure that is really just a row arriving mid-check. What we actually
    // need to know is that the users between them see everything, not that the
    // table stopped changing, so any total the table moved through passes.
    const before = await adminCount(table);
    const perUser: (number | string)[] = [];
    for (const u of users) perUser.push(await countAs(u.id, table));
    const after = await adminCount(table);
    const asStranger = await countAs(STRANGER, table);
    const asNobody = await countAs(null, table);

    const lo = Math.min(before, after);
    const hi = Math.max(before, after);
    const errored = perUser.some((n) => typeof n !== "number");
    const sum = errored ? NaN : (perUser as number[]).reduce((a, b) => a + b, 0);
    const sumOk = !errored && sum >= lo && sum <= hi;
    const bad = !sumOk || asStranger !== 0 || asNobody !== 0;
    if (bad) failures++;
    const total = before === after ? String(before) : `${lo}-${hi}`;
    // Show the addends, not just the sum: on a failure the per-user split is the
    // first thing worth seeing, and with a handful of accounts it stays readable.
    const split = perUser.join("+");
    console.log(
      `${table.padEnd(30)} ${total.padStart(7)}  ${split.padStart(12)}  ` +
        `${String(asStranger).padStart(8)}  ${String(asNobody).padStart(11)}` +
        (bad ? "   <-- UNEXPECTED" : ""),
    );
    if (!sumOk && !errored) {
      console.log(
        sum < lo
          ? `  <-- ${lo - sum} row(s) no user can read — a policy here is too tight.`
          : `  <-- ${sum - hi} row(s) read by more than one user — a policy here is too loose.`,
      );
    }
  }

  // A table with no policy is invisible to rag_app. That is correct for the four
  // orphaned topic tables (see 0051 §4) and a bug for anything else, so the list
  // is asserted rather than merely printed.
  const EXPECTED_POLICYLESS = ["chunk_topics", "topic_centroids", "topic_specimens", "topics"];
  const policyless = await admin<{ relname: string }[]>`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
    order by 1`;
  const actual = policyless.map((r) => r.relname);
  const unexpected = actual.filter((t) => !EXPECTED_POLICYLESS.includes(t));
  console.log(`\npolicy-less tables: ${actual.join(", ") || "(none)"}`);
  if (unexpected.length) {
    failures++;
    console.log(`  <-- UNEXPECTED, these are unreachable to the app: ${unexpected.join(", ")}`);
  }

  const [role] = await app`
    select current_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls`;
  console.log(`\nconnected as ${role.current_user}, bypassrls=${role.bypassrls}`);
  if (role.bypassrls) {
    failures++;
    console.log("  <-- UNEXPECTED: RAG_APP_DATABASE_URL points at a bypassing role.");
  }

  console.log(failures === 0 ? "\nOK — isolation holds." : `\nFAILED — ${failures} problem(s).`);
  await app.end();
  await admin.end();
  if (failures) process.exitCode = 1;
}

main();
