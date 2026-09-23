// THE CI EVAL GATE, the half that runs against the THROWAWAY database
// (docs/ci-eval-gate-plan.md §2). Never run directly: scripts/eval-gate.ts spawns
// it under the itest preload (`--import ./test/support/env.ts`), which is what
// points lib/db.ts at TEST_DATABASE_URL and refuses a non-local one. `load`
// truncates every table, so that refusal is the whole safety story and it is
// re-checked below before anything from lib/ is evaluated.
//
//   load    fixture files → a user, a config, chunks, overrides and the two
//           embedding_cache banks; then drops the HNSW index (exact scan)
//   score   the 118 held-out questions through the REAL retriever; writes
//           results.json and nothing to any eval table
//
// score is scoreQuestions (lib/rag/eval.ts) minus its writes, its baseline leg
// and the demo bank: same criteria, same context, same prefetch, same
// retrieveWithCutoffs. It calls those rather than scoreQuestions itself because
// the gate's subject is what retrieval RETURNS, and eval_results rows in a CI
// database are nobody's evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertLocal } from "../test/support/dbUrls";
import { readVec, fixtureHash, manifestProblems, chunkKey, type Manifest, type VecRef } from "./lib/evalGateFixture";

// Before the dynamic imports below, on purpose: lib/db.ts builds its pools from
// DATABASE_URL at module scope.
for (const name of ["DATABASE_URL", "RAG_APP_DATABASE_URL"]) {
  const url = process.env[name];
  if (!url) throw new Error(`${name} is not set — run this through \`npm run eval:gate\`, not directly`);
  assertLocal(url);
}

const FIXTURE_DIR = "test/fixtures/eval-gate";
const CORPUS_PREFIX = "eval-gate ";
const INSERT_BATCH = 100;

type Fixture = { manifest: Manifest; blob: Buffer };

function readFixture(): Fixture {
  const manifest: Manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"));
  const blob = readFileSync(join(FIXTURE_DIR, "vectors.f32"));
  // A truncated checkout (or an LFS pointer, should the blob ever move there)
  // must not load as a smaller corpus.
  const problems = manifestProblems(manifest, blob.length / 4);
  if (problems.length > 0) throw new Error(`fixture has holes:\n  ${problems.slice(0, 10).join("\n  ")}`);
  const hash = fixtureHash(manifest, blob);
  if (hash !== manifest.fixtureHash) {
    throw new Error(`fixture hash mismatch: manifest says ${manifest.fixtureHash.slice(0, 16)}…, files hash to ${hash.slice(0, 16)}…`);
  }
  return { manifest, blob };
}

// 9 significant digits round-trips a float32 exactly, and is a third the bytes
// of the double rendering `String(f32)` would send.
const literal = (blob: Buffer, ref: VecRef): string =>
  `[${Array.from(readVec(blob, ref), (x) => Number(x.toPrecision(9))).join(",")}]`;

async function load(): Promise<void> {
  const { adminClient, createUser, ensureAppRole, truncateAll } = await import("../test/support/harness");
  const { createHash } = await import("node:crypto");
  const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
  const { manifest: m, blob } = readFixture();
  const c = m.config;
  const admin = adminClient();

  try {
    await ensureAppRole(admin);
    await truncateAll(admin);
    const user = await createUser(admin);

    // The corpus name carries the fixture's identity, so `score` can refuse a
    // database that was loaded from different files.
    const [corpus] = await admin<{ id: string }[]>`
      insert into corpora (name, user_id) values (${CORPUS_PREFIX + m.fixtureHash}, ${user.id}) returning id`;
    const docs = await admin<{ id: string; file_name: string }[]>`
      insert into documents ${admin(
        m.documents.map((d) => ({ file_name: d.fileName, content_hash: d.contentHash, content: d.content, user_id: user.id })),
      )} returning id, file_name`;
    const docId = new Map(docs.map((d) => [d.file_name, d.id]));
    await admin`insert into corpus_documents ${admin(docs.map((d) => ({ corpus_id: corpus.id, document_id: d.id })))}`;

    const [cfg] = await admin<{ id: string }[]>`
      insert into configs ${admin({
        user_id: user.id,
        corpus_id: corpus.id,
        base_model: c.baseModel,
        chunk_size: c.chunkSize,
        chunk_overlap: c.chunkOverlap,
        top_k: c.topK,
        llm_model: "eval-gate",
        retrieval_fusion_pool: c.fusionPool,
        recall_k: c.recallK,
        mrr_k: c.mrrK,
        ndcg_k: c.ndcgK,
      })} returning id`;

    const perDoc = new Map<string, number>();
    for (const ch of m.chunks) perDoc.set(ch.document, (perDoc.get(ch.document) ?? 0) + 1);
    const runs = await admin<{ id: string; document_id: string }[]>`
      insert into document_embeddings ${admin(
        m.documents.map((d) => ({
          document_id: docId.get(d.fileName)!,
          model: c.baseModel,
          dimension: c.dimension,
          chunk_size: c.chunkSize,
          chunk_overlap: c.chunkOverlap,
          chunk_count: perDoc.get(d.fileName) ?? 0,
          config_id: cfg.id,
        })),
      )} returning id, document_id`;
    const runOf = new Map(runs.map((r) => [r.document_id, r.id]));

    const chunksTable = `chunks_${c.baseModel.replace(/-/g, "_")}_${c.dimension}`;
    // Ids inserted VERBATIM, not minted: fused ranks tie, and what breaks the tie
    // follows the chunk ids (see FixtureChunk.id).
    const chunkId = new Map(m.chunks.map((ch) => [ch.key, ch.id]));
    for (let i = 0; i < m.chunks.length; i += INSERT_BATCH) {
      await admin`
        insert into ${admin(chunksTable)} ${admin(
          m.chunks.slice(i, i + INSERT_BATCH).map((ch) => ({
            id: ch.id,
            document_id: docId.get(ch.document)!,
            document_embedding_id: runOf.get(docId.get(ch.document)!)!,
            position: ch.position,
            text: ch.text,
            embedding: literal(blob, ch.vec),
            config_id: cfg.id,
          })),
        )}`;
    }

    for (let i = 0; i < m.overrides.length; i += INSERT_BATCH) {
      await admin`
        insert into config_chunk_overrides ${admin(
          m.overrides.slice(i, i + INSERT_BATCH).map((o) => ({
            config_id: cfg.id,
            source_chunk_id: chunkId.get(o.chunk)!,
            piece_index: o.pieceIndex,
            model: o.model,
            dimension: o.dimension,
            kind: o.kind,
            text: o.text,
            token_start: o.tokenStart,
            token_end: o.tokenEnd,
            embedding: literal(blob, o.vec),
          })),
        )}`;
    }

    // The two banks a foreign lane reads BY TEXT HASH: the pooled chunks under
    // that model, and the question under that model. The base query vector is
    // not banked — score hands it to the retriever, as scoreQuestions does.
    const textOf = new Map(m.chunks.map((ch) => [ch.key, ch.text]));
    const bank = [
      ...m.poolDocs.map((p) => ({ kind: "document", model: p.model, text: textOf.get(p.chunk)!, vec: p.vec })),
      ...m.questions.flatMap((q) =>
        m.foreignModels.map((model) => ({ kind: "query", model, text: q.question, vec: q.qvec[model] })),
      ),
    ];
    for (let i = 0; i < bank.length; i += INSERT_BATCH) {
      await admin`
        insert into embedding_cache ${admin(
          bank.slice(i, i + INSERT_BATCH).map((b) => ({
            user_id: user.id,
            model: b.model,
            input_kind: b.kind,
            text_hash: sha256(b.text),
            dimension: b.vec[1],
            embedding: literal(blob, b.vec),
          })),
        )} on conflict do nothing`;
    }

    // EXACT SCAN (plan §0). HNSW graph construction is not identical across
    // builds, so with the index every ANN here would be a slightly different
    // approximation per run; without it every one is an exact kNN, which is what
    // lets the gate's margin be one question. The index path keeps its own itest.
    await admin.unsafe(`drop index if exists ${chunksTable}_hnsw`);
    // Planner statistics NOW, not whenever autovacuum gets to it: the unordered
    // DISTINCT that lane order falls out of (overrideStore's retrievalState) is
    // ordered by whichever plan runs it, and a plan that flips
    // between `load` and `score` is a flaky gate. These tables are far below
    // ANALYZE's sample size, so the statistics are themselves deterministic.
    await admin.unsafe("analyze");

    console.log(
      `loaded fixture ${m.fixtureHash.slice(0, 16)}… — ${m.documents.length} documents, ${chunkId.size} chunks, ` +
        `${m.overrides.length} overrides, ${bank.length} cached vectors · ${chunksTable}_hnsw dropped (exact scan)`,
    );
  } finally {
    await admin.end();
  }
}

type QuestionResult = { key: string; question: string; rank: number | null; hit: boolean; rr: number; ndcg: number | null; retrieved: string[] };

async function score(args: string[]): Promise<void> {
  const outAt = args.indexOf("--out");
  const out = outAt === -1 ? "eval-gate-results.json" : args[outAt + 1];

  const { adminClient } = await import("../test/support/harness");
  const { withUser } = await import("../lib/auth/userScope");
  const { fragment, privilegedSql, sql } = await import("../lib/db");
  const { activeConfig, resolveConfig, withConfig } = await import("../lib/rag/activeConfig");
  const { effectiveK, getActiveCriteria, retrievalDepth } = await import("../lib/rag/evalSettingsStore");
  const { ndcg, reciprocalRank } = await import("../lib/rag/evalMetrics");
  const { buildRetrievalContext, prefetchRetrieval, retrieveWithCutoffs } = await import("../lib/rag/retriever");

  const { manifest: m, blob } = readFixture();
  const admin = adminClient();

  try {
    const [owner] = await admin<{ user_id: string; email: string; config_id: string; name: string }[]>`
      select c.user_id, u.email, c.id as config_id, co.name
      from configs c join corpora co on co.id = c.corpus_id join auth.users u on u.id = c.user_id
      where co.name like ${CORPUS_PREFIX + "%"}`;
    if (!owner) throw new Error("no loaded fixture in this database — run `npm run eval:gate -- load` first");
    if (owner.name !== CORPUS_PREFIX + m.fixtureHash) {
      throw new Error("the database was loaded from a different fixture — run `npm run eval:gate -- load` again");
    }

    const results = await withUser({ id: owner.user_id, email: owner.email }, async () => {
      const cfg = await resolveConfig(owner.config_id);
      if (!cfg) throw new Error("fixture config did not resolve in user scope");
      return withConfig(cfg, async (): Promise<QuestionResult[]> => {
        const active = activeConfig();
        const criteria = await getActiveCriteria();
        const depth = retrievalDepth(criteria, active.topK);
        const recallK = effectiveK(criteria.recall, active.topK);
        const mrrK = effectiveK(criteria.mrr, active.topK);
        const ndcgK = effectiveK(criteria.ndcg, active.topK);

        const rows = await sql<{ id: string; file_name: string; position: number }[]>`
          select ch.id, d.file_name, ch.position
          from ${sql(active.chunksTable)} ch join documents d on d.id = ch.document_id
          where ch.config_id = ${active.id}`;
        const keyOf = new Map(rows.map((r) => [r.id, chunkKey(r.file_name, r.position)]));

        const ctx = await buildRetrievalContext();
        const questions = m.questions.map((q) => ({
          text: q.question,
          vector: Array.from(readVec(blob, q.qvec[m.config.baseModel])),
        }));
        await prefetchRetrieval(ctx, questions, depth);

        // THE WAY THIS GATE GOES GREEN FOR THE WRONG REASON: a foreign lane that
        // finds no vector does not fail, it goes dark, and the numbers that come
        // out describe a retrieval path production never runs. So before any
        // question is scored, every lane must have found every question's vector
        // and a cached sim for every chunk it pooled — and the message says WHICH.
        for (const model of m.foreignModels) {
          for (const q of m.questions) {
            const key = `${model}\0${q.question}`;
            if (!ctx.memo.qv.has(key)) throw new Error(`lane ${model} is dark: no query vector for "${q.question.slice(0, 50)}"`);
            const pool = ctx.memo.pool.get(key);
            if (!pool || pool.size === 0) throw new Error(`lane ${model} is dark: no pool for "${q.question.slice(0, 50)}"`);
            const cold = [...pool.values()].filter((p) => p.msim === null);
            if (cold.length > 0) {
              throw new Error(`lane ${model} is dark: ${cold.length} pooled chunk(s) have no cached vector, e.g. ${keyOf.get(cold[0].id)}`);
            }
          }
        }

        const scored: QuestionResult[] = [];
        for (const [i, q] of m.questions.entries()) {
          const { retrieved } = await retrieveWithCutoffs(q.question, questions[i].vector, depth, ctx);
          const keys = retrieved.map((r) => keyOf.get(r.chunk.chunk.id) ?? `?${r.chunk.chunk.id}`);
          const at = keys.indexOf(q.source);
          const rank = at === -1 ? null : at + 1;
          scored.push({
            key: q.source,
            question: q.question,
            rank,
            hit: rank !== null && rank <= recallK,
            rr: reciprocalRank(rank, mrrK),
            ndcg: ndcg(q.truth, keys, ndcgK),
            retrieved: keys,
          });
        }
        return scored;
      });
    });

    // Asserted with the admin handle, outside the scope: RLS would hide another
    // user's rows, and the claim is about the whole database.
    const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from provider_key_usage`;
    if (n > 0) throw new Error(`${n} provider_key_usage row(s) after scoring — the gate must not reach a provider`);

    const graded = results.filter((r) => r.ndcg !== null);
    const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    const aggregates = {
      questions: results.length,
      hits: results.filter((r) => r.hit).length,
      recall: mean(results.map((r) => (r.hit ? 1 : 0))),
      mrr: mean(results.map((r) => r.rr)),
      ndcg: mean(graded.map((r) => r.ndcg!)),
      ndcgGraded: graded.length,
    };

    // No timestamp and no ids: two runs of the same code over the same fixture
    // must produce the same BYTES, and that is tested, not assumed.
    writeFileSync(
      out,
      JSON.stringify({ fixtureHash: m.fixtureHash, scan: "exact", k: m.config.topK, aggregates, perQuestion: results }, null, 1) + "\n",
    );

    const k = m.config.topK;
    console.log(`eval gate — REGRESSION gate over frozen data · exact scan · ${m.foreignModels.length} foreign lanes fired · 0 provider calls`);
    console.log(`  fixture    ${m.fixtureHash.slice(0, 16)}… · ${results.length} questions`);
    console.log(`  Recall@${k}   ${(aggregates.recall * 100).toFixed(2)}%  (${aggregates.hits}/${results.length})`);
    console.log(`  MRR@${k}      ${aggregates.mrr.toFixed(4)}`);
    console.log(`  nDCG@${k}     ${aggregates.ndcg.toFixed(4)}  (${graded.length} graded)`);
    const misses = results.filter((r) => !r.hit);
    for (const r of misses) console.log(`  miss       ${r.key}  rank ${r.rank ?? "—"}  "${r.question.slice(0, 60)}"`);
    console.log(`wrote ${out}`);

    await (fragment as unknown as { end: () => Promise<void> }).end();
    await privilegedSql.end();
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "load") return load();
  if (command === "score") return score(args);
  throw new Error(`unknown subcommand ${command}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
