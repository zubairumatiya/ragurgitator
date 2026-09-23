// THE CI EVAL GATE (docs/ci-eval-gate-plan.md).
//
//   npm run eval:gate -- export [--seed N] [--pct N] [--out DIR]
//   npm run eval:gate -- load
//   npm run eval:gate -- score [--out FILE]
//
// `export` freezes the master config's retrieval inputs into
// test/fixtures/eval-gate/ — corpus, overrides, every foreign lane's pool and
// query vectors, and a held-out question set drawn ONCE, here. It is the only
// subcommand that touches the live database; it issues selects and nothing else,
// and it is run by hand. A refresh is a reviewed PR diff, never a CI side effect
// (decision 6).
//
// A REGRESSION GATE, NOT A GENERALIZATION MEASURE. All 472 of the master's
// questions have been autotune targets, so the split drawn here is contaminated
// in the 0074 sense by construction. That is fine for what the gate asks — "did
// this PR's code change what retrieval returns on fixed data" — and it is why
// the split lives in the repo and is deliberately NOT written to the master's
// config_question_ignores: turning the live holdout on would change what /eval
// shows to answer a question nobody asked there.
//
// RAW SQL ON PURPOSE. The app's stores read an AsyncLocalStorage scope and
// import the server graph; this reads eight tables once, as the `postgres` role,
// so it names the owner's user_id itself wherever RLS would have.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { sameVectorSpace } from "../lib/rag/embeddingModels";
import { holdoutSplitKey, holdoutTarget, selectHoldout } from "../lib/rag/holdout";
import {
  VectorBlob,
  chunkKey,
  decodeVectorSend,
  fixtureHash,
  manifestProblems,
  serializeManifest,
  type FixtureQuestion,
  type Manifest,
  type VecRef,
} from "./lib/evalGateFixture";

const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";
const DEFAULT_OUT = "test/fixtures/eval-gate";

type Sql = ReturnType<typeof postgres>;

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

async function exportFixture(args: string[]): Promise<void> {
  // The one subcommand that reads live, so it loads the live env itself rather
  // than the npm script passing --env-file to every subcommand: `score` must run
  // under the itest preload, which refuses a non-local DATABASE_URL.
  if (!process.env.DATABASE_URL) process.loadEnvFile(".env.local");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (expected in .env.local)");

  const seed = Number(flag(args, "seed") ?? 1);
  const pct = Number(flag(args, "pct") ?? 25);
  const outDir = flag(args, "out") ?? DEFAULT_OUT;
  if (!Number.isInteger(seed) || !(pct > 0 && pct <= 100)) throw new Error("--seed wants an integer, --pct a percentage");

  const sql: Sql = postgres(url, { prepare: false, ssl: sslFor(url), max: 1 });
  try {
    const { manifest, blob } = await build(sql, seed, pct);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "vectors.f32"), blob);
    writeFileSync(join(outDir, "manifest.json"), serializeManifest(manifest));
    census(manifest, blob, outDir);
  } finally {
    await sql.end();
  }
}

async function build(sql: Sql, seed: number, pct: number): Promise<{ manifest: Manifest; blob: Buffer }> {
  const [cfg] = await sql<
    {
      user_id: string;
      base_model: string;
      chunk_size: number;
      chunk_overlap: number;
      top_k: number;
      retrieval_fusion_pool: number | null;
      recall_k: number | null;
      mrr_k: number | null;
      ndcg_k: number | null;
    }[]
  >`
    select user_id, base_model, chunk_size, chunk_overlap, top_k,
           retrieval_fusion_pool, recall_k, mrr_k, ndcg_k
    from configs where id = ${CONFIG_ID}`;
  if (!cfg) throw new Error(`config ${CONFIG_ID} not found`);

  const docs = await sql<
    { id: string; file_name: string; content_hash: string; content: string; dimension: number }[]
  >`
    select d.id, d.file_name, d.content_hash, d.content, de.dimension
    from document_embeddings de join documents d on d.id = de.document_id
    where de.config_id = ${CONFIG_ID} and de.model = ${cfg.base_model}
    order by d.file_name`;
  if (docs.length === 0) throw new Error("config has no embedded documents");
  const dimension = docs[0].dimension;
  if (docs.some((d) => d.dimension !== dimension)) throw new Error("documents disagree on the base dimension");

  // vectorStore.chunksTable's naming convention, restated rather than imported:
  // that module pulls in the app's db scope, and a wrong guess here fails on the
  // next statement, loudly.
  const chunksTable = `chunks_${cfg.base_model.replace(/-/g, "_")}_${dimension}`;

  // Vectors cross the wire as `encode(vector_send(…), 'base64')` — pgvector's
  // binary form: exact, and well under half the bytes of the text rendering for
  // the ~3.2 M floats this reads.
  const blob = new VectorBlob();
  const add = (b64: string): VecRef => blob.add(decodeVectorSend(b64));
  const fileOf = new Map(docs.map((d) => [d.id, d.file_name]));

  const chunkRows = await sql<{ id: string; document_id: string; position: number; text: string; vec: string }[]>`
    select id, document_id, position, text, encode(vector_send(embedding), 'base64') as vec
    from ${sql(chunksTable)}
    where config_id = ${CONFIG_ID}
    order by document_id, position`;
  const keyOf = new Map<string, string>();
  const chunks = chunkRows
    .map((r) => {
      const document = fileOf.get(r.document_id);
      if (!document) throw new Error(`chunk ${r.id} belongs to a document outside the config`);
      const key = chunkKey(document, r.position);
      keyOf.set(r.id, key);
      return { key, id: r.id, document, position: r.position, text: r.text, vec: add(r.vec) };
    })
    .sort((a, b) => a.document.localeCompare(b.document) || a.position - b.position);

  const keyFor = (id: string, what: string): string => {
    const key = keyOf.get(id);
    if (!key) throw new Error(`${what} names chunk ${id}, which is not in ${chunksTable} for this config`);
    return key;
  };

  const overrideRows = await sql<
    {
      source_chunk_id: string;
      piece_index: number;
      model: string;
      dimension: number;
      kind: string;
      text: string | null;
      token_start: number | null;
      token_end: number | null;
      vec: string;
    }[]
  >`
    select source_chunk_id, piece_index, model, dimension, kind, text, token_start, token_end,
           encode(vector_send(embedding), 'base64') as vec
    from config_chunk_overrides
    where config_id = ${CONFIG_ID}`;
  const overrides = overrideRows
    .map((r) => ({
      chunk: keyFor(r.source_chunk_id, "an override"),
      pieceIndex: r.piece_index,
      model: r.model,
      dimension: r.dimension,
      kind: r.kind,
      text: r.text,
      tokenStart: r.token_start,
      tokenEnd: r.token_end,
      vec: add(r.vec),
    }))
    .sort((a, b) => a.chunk.localeCompare(b.chunk) || a.model.localeCompare(b.model) || a.pieceIndex - b.pieceIndex);

  // An override in the base model's own vector space folds into the base lane
  // and needs nothing beyond its own vector. Every OTHER model opens a fusion
  // lane, and a lane reads two things out of embedding_cache by text hash: the
  // question under that model, and the pooled chunks under that model.
  const foreignModels = [...new Set(overrides.map((o) => o.model))]
    .filter((m) => !sameVectorSpace(m, cfg.base_model))
    .sort();

  // One statement per model: ~236 rows of 4–6 kB each is a comfortable result,
  // six of them at once is not.
  const poolDocs: Manifest["poolDocs"] = [];
  for (const model of foreignModels) {
    const rows = await sql<{ id: string; vec: string | null }[]>`
      with p as materialized (
        select id, encode(sha256(text::bytea), 'hex') as text_hash
        from ${sql(chunksTable)} where config_id = ${CONFIG_ID}
      )
      select p.id, encode(vector_send(ec.embedding), 'base64') as vec
      from p
      left join embedding_cache ec
        on ec.user_id = ${cfg.user_id} and ec.model = ${model}
       and ec.input_kind = 'document' and ec.text_hash = p.text_hash`;
    const missing = rows.filter((r) => r.vec === null).map((r) => keyFor(r.id, "the pool"));
    if (missing.length > 0) {
      throw new Error(`${missing.length} chunk text(s) have no cached document vector under ${model}: ${missing.slice(0, 5).join(", ")}`);
    }
    for (const r of rows) poolDocs.push({ model, chunk: keyFor(r.id, "the pool"), vec: add(r.vec!) });
  }
  poolDocs.sort((a, b) => a.model.localeCompare(b.model) || a.chunk.localeCompare(b.chunk));

  // THE SPLIT, drawn once with the product's own stratified draw. Candidates are
  // every question labelled under this config — the same population /eval shows.
  const candidates = await sql<{ id: string; difficulty: string | null }[]>`
    select q.id, q.difficulty
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${CONFIG_ID}`;
  const target = holdoutTarget(candidates.length, { enabled: true, mode: "pct", size: pct, seed });
  const held = selectHoldout(
    candidates.map((c) => ({ questionId: c.id, difficulty: c.difficulty })),
    target,
    seed,
  );
  if (held.length === 0) throw new Error("the split is empty");

  const questionRows = await sql<
    {
      id: string;
      question: string;
      difficulty: string | null;
      expected_answer: string | null;
      source_chunk_id: string;
      truth: string[] | null;
      base_vec: string | null;
    }[]
  >`
    select q.id, q.question, q.difficulty, q.expected_answer, l.source_chunk_id,
           r.chunk_ids as truth,
           encode(vector_send(e.embedding::vector), 'base64') as base_vec
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id and de.config_id = ${CONFIG_ID}
    left join eval_rankings r
      on r.eval_question_id = q.id and r.document_embedding_id = l.document_embedding_id and r.is_truth
    left join eval_question_embeddings e
      on e.eval_question_id = q.id and e.model = ${cfg.base_model}
    where q.id = any(${held}::uuid[])`;
  if (questionRows.length !== held.length) {
    throw new Error(`drew ${held.length} questions but read ${questionRows.length} back — a question carries more than one label in this config`);
  }

  // Foreign query vectors, by text hash, exactly as embedQueryCached finds them.
  const foreignQ = new Map<string, Map<string, string>>();
  for (const model of foreignModels) {
    const rows = await sql<{ id: string; vec: string }[]>`
      select q.id, encode(vector_send(ec.embedding), 'base64') as vec
      from eval_questions q
      join embedding_cache ec
        on ec.user_id = ${cfg.user_id} and ec.model = ${model} and ec.input_kind = 'query'
       and ec.text_hash = encode(sha256(q.question::bytea), 'hex')
      where q.id = any(${held}::uuid[])`;
    foreignQ.set(model, new Map(rows.map((r) => [r.id, r.vec])));
  }

  const questions: FixtureQuestion[] = questionRows
    .map((r) => {
      const where = `question "${r.question.slice(0, 50)}"`;
      if (!r.truth || r.truth.length === 0) throw new Error(`${where} has no is_truth ranking`);
      if (!r.base_vec) throw new Error(`${where} has no cached ${cfg.base_model} query vector`);
      const qvec: Record<string, VecRef> = { [cfg.base_model]: add(r.base_vec) };
      for (const model of foreignModels) {
        const vec = foreignQ.get(model)!.get(r.id);
        if (!vec) throw new Error(`${where} has no cached query vector under ${model}`);
        qvec[model] = add(vec);
      }
      return {
        question: r.question,
        difficulty: r.difficulty,
        expectedAnswer: r.expected_answer,
        source: keyFor(r.source_chunk_id, where),
        truth: r.truth.map((id) => keyFor(id, `${where}'s truth ranking`)),
        qvec,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.question.localeCompare(b.question));

  const manifest: Manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceConfigId: CONFIG_ID,
    fixtureHash: "",
    config: {
      baseModel: cfg.base_model,
      dimension,
      chunkSize: cfg.chunk_size,
      chunkOverlap: cfg.chunk_overlap,
      topK: cfg.top_k,
      fusionPool: cfg.retrieval_fusion_pool,
      recallK: cfg.recall_k,
      mrrK: cfg.mrr_k,
      ndcgK: cfg.ndcg_k,
    },
    foreignModels,
    split: { mode: "pct", size: pct, seed, candidates: candidates.length, splitKey: holdoutSplitKey(held) },
    documents: docs.map((d) => ({ fileName: d.file_name, contentHash: d.content_hash, content: d.content })),
    chunks,
    overrides,
    poolDocs,
    questions,
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
  const bands = new Map<string, number>();
  for (const q of m.questions) bands.set(q.difficulty ?? "—", (bands.get(q.difficulty ?? "—") ?? 0) + 1);
  const byModel = new Map<string, number>();
  for (const o of m.overrides) byModel.set(o.model, (byModel.get(o.model) ?? 0) + 1);

  console.log(`eval gate fixture — REGRESSION gate over frozen data, not a generalization measure`);
  console.log(`  source     config ${m.sourceConfigId.slice(0, 8)} · ${m.config.baseModel} · top_k ${m.config.topK}`);
  console.log(`  documents  ${m.documents.length}`);
  console.log(`  chunks     ${m.chunks.length}`);
  console.log(`  overrides  ${m.overrides.length} (${[...byModel].map(([k, n]) => `${k} ${n}`).join(", ")})`);
  console.log(`  pool docs  ${m.poolDocs.length} (${m.foreignModels.length} foreign lanes × ${m.chunks.length})`);
  console.log(
    `  questions  ${m.questions.length} of ${m.split.candidates} ` +
      `(${[...bands].map(([k, n]) => `${n} ${k}`).join(" + ")}) × ${1 + m.foreignModels.length} query vectors`,
  );
  console.log(`  split      ${m.split.size}% seed ${m.split.seed} · key ${m.split.splitKey}`);
  console.log(`  vectors    ${(blob.length / 4).toLocaleString()} float32 · ${(blob.length / 1e6).toFixed(1)} MB`);
  console.log(`  hash       ${m.fixtureHash.slice(0, 16)}…`);
  console.log(`wrote ${outDir}/manifest.json and ${outDir}/vectors.f32`);
}

// Everything but `export` runs against the throwaway database, in a CHILD started
// under the itest preload: test/support/env.ts has to claim DATABASE_URL before
// lib/db.ts is evaluated, and a preload is the only place that is early enough.
// It also refuses a non-local URL, which is what makes `load`'s truncate safe to
// expose as an npm script. `export` is the reverse case — it needs the live URL
// that preload exists to refuse — hence two processes rather than one flag.
const LOCAL_COMMANDS = ["load", "score"];

function runLocal(argv: string[]): never {
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--import", "./test/support/env.ts", "scripts/eval-gate-run.ts", ...argv],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "export") return exportFixture(args);
  if (LOCAL_COMMANDS.includes(command)) runLocal([command, ...args]);
  console.error("usage: npm run eval:gate -- export [--seed N] [--pct N] [--out DIR] | load | score [--out FILE]");
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
