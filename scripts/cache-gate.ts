// THE SEMANTIC CACHE GATE (docs/semantic-cache-gate-plan.md).
//
//   npm run cache:gate -- export [--out DIR]
//   npm run cache:gate -- score [--out FILE]
//   npm run cache:gate -- baseline
//   npm run cache:gate -- gate [--strict]
//
// `export` freezes the two non-pure inputs of the cache's match decision — the
// key-model vector of every labelled text, and τ — together with the labelled
// pairs themselves (the generated set, quarantined rows included, and the judged
// shadow log) into test/fixtures/cache-gate/. It is the only subcommand that
// touches the live database; it issues selects and nothing else, and it is run
// by hand. A refresh is a reviewed PR diff, never a CI side effect.
//
// The other three are PURE: no database, no service, no child process, no
// network — scripts/lib/cacheGateCore.ts is held to an import allow-list by a
// unit test. The decision they re-run is the serving path's own
// (lib/rag/semanticCacheCore.ts), which is why they must never re-implement it.
//
// WHEN TO REFRESH. `export` again when pairs are generated, shadow rows are
// judged, or a quarantine verdict lands: the fixture hash changes and `gate`
// refuses until `baseline` is re-run in the same PR. `baseline` again when a
// guard or τ change is INTENDED; the PR carries the new per-pair decisions and
// the reviewer sees exactly which pairs flipped, which is the review F6 did by
// hand.
//
// RAW SQL ON PURPOSE, as in scripts/eval-gate.ts: the app's stores read an
// AsyncLocalStorage scope, so this names the owner's user_id itself.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { config } from "../lib/config";
import { sslFor } from "../lib/dbSsl";
import { EMBEDDING_MODELS } from "../lib/rag/embeddingModels";
import { spaceOf } from "../lib/rag/semanticCacheCore";
import {
  VectorBlob,
  decodeVectorSend,
  fixtureHash,
  manifestProblems,
  serializeManifest,
  textHash,
  textsOf,
  type FixtureGenerated,
  type FixtureShadow,
  type FixtureTau,
  type Manifest,
} from "./lib/cacheGateFixture";

const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";
export const FIXTURE_DIR = "test/fixtures/cache-gate";

type Sql = ReturnType<typeof postgres>;

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

async function exportFixture(args: string[]): Promise<void> {
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env.local");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (expected in .env.local)");
  const outDir = flag(args, "out") ?? FIXTURE_DIR;

  const sql: Sql = postgres(url, { prepare: false, ssl: sslFor(url), max: 1 });
  try {
    const { manifest, blob } = await build(sql);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "vectors.f32"), blob);
    writeFileSync(join(outDir, "manifest.json"), serializeManifest(manifest));
    census(manifest, blob, outDir);
  } finally {
    await sql.end();
  }
}

async function build(sql: Sql): Promise<{ manifest: Manifest; blob: Buffer }> {
  const [cfg] = await sql<{ user_id: string; sc: { keyModel?: string | null; threshold?: number | null } | null }[]>`
    select user_id, batch_savings->'semanticCache' as sc from configs where id = ${CONFIG_ID}`;
  if (!cfg) throw new Error(`config ${CONFIG_ID} not found`);
  const owner = cfg.user_id;

  // resolveKeyModel and resolveThreshold (lib/rag/semanticCache.ts), restated
  // for a raw connection: per-config override → calibrated space row → the code
  // default. The source travels so a red run can say whose dial τ was.
  const keyOverride = cfg.sc?.keyModel ?? null;
  const keyModel = keyOverride !== null && EMBEDDING_MODELS[keyOverride] ? keyOverride : config.semanticCache.keyModel;
  const space = spaceOf(keyModel);
  const dimension = EMBEDDING_MODELS[keyModel]?.dimension;
  if (!dimension) throw new Error(`key model ${keyModel} has no dimension in EMBEDDING_MODELS`);
  let tau: FixtureTau;
  if (cfg.sc?.threshold != null) tau = { value: Number(cfg.sc.threshold), source: "config" };
  else {
    const [row] = await sql<{ threshold: number }[]>`
      select threshold from semantic_cache_thresholds where user_id = ${owner} and space = ${space}`;
    tau = row ? { value: Number(row.threshold), source: "calibrated" } : { value: config.semanticCache.defaultThreshold, source: "default" };
  }

  // ALL of the owner's generated pairs — the quarantine is poolPairs' job, at
  // gate time, so the rule itself stays under test. Ownership goes through the
  // origin question's document, as listPairs does.
  const generated: FixtureGenerated[] = (
    await sql<{ text_a: string; text_b: string; label: string; difficulty: string; verdict: string | null; verdict_source: string | null }[]>`
      select p.text_a, p.text_b, p.label, p.difficulty, p.verdict, p.verdict_source
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
      where d.user_id = ${owner}
      order by p.hash_a, p.hash_b`
  ).map((r) => ({
    textA: r.text_a,
    textB: r.text_b,
    label: r.label as FixtureGenerated["label"],
    difficulty: r.difficulty,
    verdict: r.verdict as FixtureGenerated["verdict"],
    verdictSource: r.verdict_source,
  }));

  // Judged shadow rows only: an unjudged row has no truth to gate on. Rows are
  // restricted to the key model in force — a row captured under another model
  // is a different experiment — and a question re-asked VERBATIM is left out:
  // it is not a similarity decision (poolPairs drops it too), and the fixture
  // validator refuses a self-pair.
  const shadowRows = await sql<{ new_query: string; matched_query: string; verdict: string; origin: string; sim: number; guard_blocked: boolean }[]>`
      select s.new_query, s.matched_query, s.verdict, s.origin, s.sim, s.guard_blocked
      from semantic_cache_shadow s
      where s.verdict is not null
        and s.embedding_model = ${keyModel}
        and s.config_id in (select id from configs where user_id = ${owner})
      order by s.new_query_hash, s.fingerprint, s.config_id`;
  const verbatim = shadowRows.filter((r) => r.new_query === r.matched_query).length;
  const shadow: FixtureShadow[] = shadowRows.filter((r) => r.new_query !== r.matched_query).map((r) => ({
    textA: r.new_query,
    textB: r.matched_query,
    verdict: r.verdict as FixtureShadow["verdict"],
    origin: r.origin as FixtureShadow["origin"],
    simAtCapture: Number(r.sim),
    guardBlockedAtCapture: r.guard_blocked,
  }));
  if (verbatim > 0) console.log(`  (left out ${verbatim} judged shadow row(s) where the question was re-asked verbatim)`);

  // One vector per distinct text, from embedding_cache by text hash — exactly
  // where embedQueryCached would find it. Refuse on ANY miss: a text without a
  // vector cannot be decided, and today there are none.
  const texts = [...textsOf({ generated, shadow })].sort();
  const hashes = texts.map(textHash);
  const rows = await sql<{ text_hash: string; vec: string }[]>`
    select text_hash, encode(vector_send(embedding), 'base64') as vec
    from embedding_cache
    where user_id = ${owner} and model = ${keyModel} and input_kind = 'query' and text_hash = any(${hashes})`;
  const byHash = new Map(rows.map((r) => [r.text_hash, r.vec]));
  const missing = texts.filter((t) => !byHash.has(textHash(t)));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} text(s) have no cached ${keyModel} query vector — the export must not embed anything: ` +
        missing.slice(0, 5).map((t) => `"${t.slice(0, 40)}"`).join(", "),
    );
  }
  const blob = new VectorBlob();
  const vectors: Manifest["vectors"] = {};
  for (const t of texts) vectors[textHash(t)] = blob.add(decodeVectorSend(byHash.get(textHash(t))!));

  const manifest: Manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceConfigId: CONFIG_ID,
    fixtureHash: "",
    keyModel,
    space,
    dimension,
    tau,
    generated,
    shadow,
    vectors,
  };
  const bytes = blob.toBuffer();
  const problems = manifestProblems(manifest, blob.length);
  if (problems.length > 0) {
    throw new Error(`refusing to write a fixture with holes:\n  ${problems.slice(0, 20).join("\n  ")}` +
      (problems.length > 20 ? `\n  …and ${problems.length - 20} more` : ""));
  }
  manifest.fixtureHash = fixtureHash(manifest, bytes);
  return { manifest, blob: bytes };
}

function census(m: Manifest, blob: Buffer, outDir: string): void {
  const count = <T>(xs: T[], f: (x: T) => string) => {
    const c = new Map<string, number>();
    for (const x of xs) c.set(f(x), (c.get(f(x)) ?? 0) + 1);
    return [...c].sort().map(([k, n]) => `${n} ${k}`).join(", ");
  };
  const quarantined = m.generated.filter((g) => g.verdict !== null && g.verdict !== (g.label === "same" ? "accept" : "reject"));
  console.log(`semantic cache gate fixture — the MATCH DECISION over frozen pairs, not a precision estimate`);
  console.log(`  source     config ${m.sourceConfigId.slice(0, 8)} · key model ${m.keyModel} (${m.space}, ${m.dimension}d)`);
  console.log(`  tau        ${m.tau.value} (${m.tau.source})`);
  console.log(`  generated  ${m.generated.length} (${count(m.generated, (g) => `${g.label}/${g.difficulty}`)}) · ${quarantined.length} quarantined by verdict`);
  console.log(`  shadow     ${m.shadow.length} judged (${count(m.shadow, (s) => `${s.origin}/${s.verdict}`)})`);
  console.log(`  texts      ${Object.keys(m.vectors).length} distinct · ${(blob.length / 4).toLocaleString()} float32 · ${(blob.length / 1e6).toFixed(1)} MB`);
  console.log(`  hash       ${m.fixtureHash.slice(0, 16)}…`);
  console.log(`wrote ${outDir}/manifest.json and ${outDir}/vectors.f32`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "export") return exportFixture(args);
  if (["score", "baseline", "gate"].includes(command)) {
    const { run } = await import("./cache-gate-run");
    return run(command as "score" | "baseline" | "gate", args);
  }
  console.error("usage: npm run cache:gate -- export [--out DIR] | score [--out FILE] | baseline | gate [--strict]");
  process.exit(2);
}

main().then(
  () => process.exit(Number(process.exitCode ?? 0)),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
