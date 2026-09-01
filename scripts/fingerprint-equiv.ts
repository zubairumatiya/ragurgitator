// FINGERPRINT EQUIVALENCE — the gate on docs/demo-egress-plan.md phase 6.
//
//   npm run fingerprint:equiv
//
// `retrievalStateFingerprint` used to download every override piece row and
// sha-256 a string built in JS; it now asks Postgres to build and hash the same
// string. The saving is small (~64 MB) and the blast radius is not: the digest
// is stamped on every eval result and a result is stale iff its fingerprint
// differs, so a ONE-BYTE drift stales everything scored in the database and
// triggers a full re-score of the master.
//
// So the old JS form is frozen below as the reference implementation — it is
// not dead code, it is the oracle — and this driver asserts byte equality
// against the shipping SQL form over live, for the three cases §1.5 names: the
// master (274 pieces), `ww2 test` (4 pieces, and the only config with null
// spans), and a config with zero override rows (the `baseline` string).
//
// Runs against LIVE and reads nothing but the pieces table, so it costs $0 and
// changes nothing.
import { createHash } from "node:crypto";

import postgres from "postgres";

import { withUser } from "../lib/auth/userScope";
import { sql } from "../lib/db";
import { sslFor } from "../lib/dbSsl";
import { activeConfig, resolveConfig, withConfig } from "../lib/rag/activeConfig";
import { FUSION_VERSION, retrievalStateFingerprint } from "../lib/rag/overrideStore";

// The three cases §1.5 requires, by id. Overridable so a second account can run
// this against its own configs.
const CASES: { id: string; what: string; pool?: number }[] = [
  { id: "45b73063-403e-4a44-8d6e-b9eacf7e316a", what: "master (274 pieces)" },
  { id: "ef6dac59-0b58-4254-9b8a-d955723dcad0", what: "ww2 test (4 pieces)" },
  { id: "7d4933b1-6aae-4545-a8db-7b611f8e6a8c", what: "zero override rows (baseline)" },
  // Every config live runs on the auto pool (null), so the three cases above
  // all take the empty-prefix branch and none of them would catch a drift in
  // the `pool-N` line. This one forces a pool onto the master's resolved config
  // — nothing is written, only the in-memory value the digest reads.
  { id: "45b73063-403e-4a44-8d6e-b9eacf7e316a", what: "master with an explicit pool", pool: 60 },
];

// The pre-phase-6 implementation, verbatim apart from its name. Do not
// "improve" it: its value is that it is the code the stored fingerprints were
// produced by.
async function referenceFingerprint(): Promise<string> {
  const cfg = activeConfig();
  const rows = await sql<
    {
      source_chunk_id: string;
      model: string;
      kind: string;
      piece_index: number;
      token_start: number | null;
      token_end: number | null;
      text_hash: string | null;
    }[]
  >`
    select source_chunk_id, model, kind, piece_index, token_start, token_end,
           md5(text) as text_hash
    from config_chunk_overrides
    where config_id = ${cfg.id}
    order by source_chunk_id, piece_index
  `;
  if (rows.length === 0) return "baseline";
  const canonical =
    `fusion-v${FUSION_VERSION}\n` +
    (cfg.fusionPool === null ? "" : `pool-${cfg.fusionPool}\n`) +
    rows
      .map(
        (r) =>
          `${r.source_chunk_id}|${r.model}|${r.kind}|${r.piece_index}|` +
          `${r.token_start ?? ""}|${r.token_end ?? ""}|${r.text_hash ?? ""}`,
      )
      .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

// Owner lookup only. The scoped `sql` cannot answer it (it refuses to run
// outside a user scope, which is exactly what we are trying to establish) and
// `privilegedSql` is reserved for its three callers, so this takes its own
// connection the way scripts/egress-meter.ts does.
const raw = postgres(process.env.DATABASE_URL ?? "", { ssl: sslFor(process.env.DATABASE_URL ?? "") });

// A driver runs outside a request, so nothing has populated the user/config
// scopes every lib/rag function reads. The owner comes from the config row so
// the two cannot disagree (the cases below span more than one account).
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
  for (const c of CASES) {
    const [ref, live] = await inScope(c.id, c.pool, async () => [
      await referenceFingerprint(),
      await retrievalStateFingerprint(),
    ]);
    const ok = ref === live;
    if (!ok) failed++;
    console.log(`${ok ? "OK  " : "FAIL"}  ${c.id.slice(0, 8)}  ${c.what}`);
    console.log(`        js  ${ref}`);
    console.log(`        sql ${live}`);
  }
  console.log(
    failed === 0
      ? `\nall ${CASES.length} cases byte-equal`
      : `\n${failed}/${CASES.length} cases DIVERGED — see docs/demo-egress-plan.md phase 6`,
  );
  // Only `raw` is ours to close: the scoped client is a proxy that refuses to
  // be touched outside a user scope, and process.exit drops it anyway.
  await raw.end();
  process.exit(failed === 0 ? 0 : 1);
}

main();
