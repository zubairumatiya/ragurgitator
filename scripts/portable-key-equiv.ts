// PORTABLE KEY EQUIVALENCE — phase 0 of docs/demo-retrieval-bank-plan.md.
//
//   npm run portable-key:equiv                      JS reference vs SQL, default cases
//   npm run portable-key:equiv -- --pair <a> <b>    … plus: configs a and b (a seed and
//                                                   a guest after the same press) key
//                                                   identically and fingerprint differently
//
// `portableRetrievalKey` (lib/rag/overrideStore) is the 0022 fingerprint with
// each override row's chunk id replaced by the md5 of the chunk's text, built and
// hashed in Postgres. It is the ONLY key into the demo's retrieval bank, so a
// one-byte drift between what the SQL builds and what this file says it builds
// is a bank that never hits and never says why — the same reason
// scripts/fingerprint-equiv.ts freezes the JS form of the fingerprint.
//
// Two assertions, and they are different in kind:
//   1. The SQL form equals the JS reference below, per config, byte for byte.
//   2. (--pair) Two workspaces holding the same override set over the same
//      corpus produce the SAME key and DIFFERENT fingerprints. The itest
//      (test/integration/demoRetrievalBank.itest.ts, case 6) proves this across a
//      real clone; this is the live check on real ids.
//
// Runs against LIVE and reads nothing but override rows and chunk texts, so it
// costs $0 and changes nothing.
import { createHash } from "node:crypto";

import postgres from "postgres";

import { withUser } from "../lib/auth/userScope";
import { sql } from "../lib/db";
import { sslFor } from "../lib/dbSsl";
import { activeConfig, resolveConfig, withConfig } from "../lib/rag/activeConfig";
import {
  FUSION_VERSION,
  portableRetrievalKey,
  retrievalStateFingerprint,
} from "../lib/rag/overrideStore";

// fingerprint-equiv's cases, so the two scripts stay comparable.
const CASES: { id: string; what: string; pool?: number }[] = [
  { id: "45b73063-403e-4a44-8d6e-b9eacf7e316a", what: "master (274 pieces)" },
  { id: "ef6dac59-0b58-4254-9b8a-d955723dcad0", what: "ww2 test (4 pieces)" },
  { id: "2eb8d516-818b-4fe8-ac29-77ba94e48ad7", what: "the demo seed, zero override rows (baseline)" },
  { id: "45b73063-403e-4a44-8d6e-b9eacf7e316a", what: "master with an explicit pool", pool: 60 },
];

// THE REFERENCE. Rows are read unordered and sorted here on the same tuple the
// SQL's `order by` names, so a drift in the SQL's ordering — the likeliest
// mistake — is caught rather than mirrored.
async function referenceKey(): Promise<string> {
  const cfg = activeConfig();
  const rows = await sql<
    {
      chunk_hash: string;
      model: string;
      kind: string;
      piece_index: number;
      token_start: number | null;
      token_end: number | null;
      text_hash: string | null;
    }[]
  >`
    select md5(c.text) as chunk_hash, o.model, o.kind, o.piece_index, o.token_start, o.token_end,
           md5(o.text) as text_hash
      from config_chunk_overrides o
      join ${sql(cfg.chunksTable)} c on c.id = o.source_chunk_id
     where o.config_id = ${cfg.id}
  `;
  if (rows.length === 0) return "baseline";
  const tuple = (r: (typeof rows)[number]) => [
    r.chunk_hash,
    r.piece_index,
    r.model,
    r.kind,
    r.token_start ?? "",
    r.token_end ?? "",
    r.text_hash ?? "",
  ] as const;
  // Postgres collates text with the database's collation; every field here is
  // hex, a model id, a kind or a number rendered as text, so a byte compare is
  // the same order. piece_index is compared as a NUMBER (the column's type).
  rows.sort((a, b) => {
    const ta = tuple(a);
    const tb = tuple(b);
    for (let i = 0; i < ta.length; i++) {
      const x = ta[i];
      const y = tb[i];
      if (x === y) continue;
      if (typeof x === "number" && typeof y === "number") return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  });
  const canonical =
    `fusion-v${FUSION_VERSION}\n` +
    (cfg.fusionPool === null ? "" : `pool-${cfg.fusionPool}\n`) +
    rows
      .map(
        (r) =>
          `${r.chunk_hash}|${r.model}|${r.kind}|${r.piece_index}|` +
          `${r.token_start ?? ""}|${r.token_end ?? ""}|${r.text_hash ?? ""}`,
      )
      .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

const raw = postgres(process.env.DATABASE_URL ?? "", { ssl: sslFor(process.env.DATABASE_URL ?? "") });

async function inScope<T>(configId: string, pool: number | undefined, fn: () => Promise<T>): Promise<T> {
  const [row] = await raw<{ user_id: string; email: string }[]>`
    select c.user_id, u.email from configs c join auth.users u on u.id = c.user_id
    where c.id = ${configId}`;
  if (!row) throw new Error(`config ${configId} not found`);
  return withUser({ id: row.user_id, email: row.email }, async () => {
    const cfg = await resolveConfig(configId);
    if (!cfg) throw new Error(`config ${configId} not visible in its owner's scope`);
    return withConfig(pool === undefined ? cfg : { ...cfg, fusionPool: pool }, fn);
  });
}

async function main() {
  let failed = 0;
  const pairAt = process.argv.indexOf("--pair");
  const pair = pairAt === -1 ? null : [process.argv[pairAt + 1], process.argv[pairAt + 2]];
  const cases: typeof CASES = pair ? [...CASES, ...pair.map((id) => ({ id, what: "pair member" }))] : CASES;

  for (const c of cases) {
    const [ref, live] = await inScope(c.id, c.pool, async () => [
      await referenceKey(),
      await portableRetrievalKey(),
    ]);
    const ok = ref === live;
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"}  ${c.id.slice(0, 8)}  ${c.what}`);
    console.log(`        js  ${ref}`);
    console.log(`        sql ${live}`);
  }

  if (pair) {
    const [a, b] = await Promise.all(
      pair.map((id) =>
        inScope(id, undefined, async () => ({
          key: await portableRetrievalKey(),
          fingerprint: await retrievalStateFingerprint(),
        })),
      ),
    );
    const sameKey = a.key === b.key;
    const differentFingerprint = a.fingerprint !== b.fingerprint;
    if (!sameKey || !differentFingerprint) failed++;
    console.log(`\n${sameKey ? "OK  " : "FAIL"}  portable keys ${sameKey ? "agree" : "DIFFER"}`);
    console.log(`        a ${a.key}\n        b ${b.key}`);
    console.log(
      `${differentFingerprint ? "OK  " : "FAIL"}  fingerprints ${differentFingerprint ? "differ" : "AGREE (the two configs share chunk ids?)"}`,
    );
    console.log(`        a ${a.fingerprint}\n        b ${b.fingerprint}`);
  }

  console.log(
    failed === 0
      ? `\nall ${cases.length} case(s) byte-equal${pair ? ", and the pair keys as one state" : ""}`
      : `\n${failed} check(s) FAILED — see docs/demo-retrieval-bank-plan.md §3.1`,
  );
  await raw.end();
  process.exit(failed === 0 ? 0 : 1);
}

main();
