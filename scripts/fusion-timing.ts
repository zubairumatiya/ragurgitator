// FUSION LATENCY — what one question costs on the fusion path, and where.
//
//   SCRIPT_CONFIG_ID=<uuid> npm run fusion:timing
//
// docs/fusion-latency-plan.md §0: the demo's autotune finale spends 209 s
// re-scoring 60 questions while making ZERO provider calls, so the cost is
// retrieval. This is the instrument that says which leg of retrieval — it runs
// the SAME call the eval scorer runs (retrieveWithCutoffs through a shared
// RetrievalContext), over the same board, at the same concurrency, and times the
// underlying SQL separately so a slow question can be attributed rather than
// guessed at.
//
// READ-ONLY AND FREE. It scores nothing and writes nothing: no eval_results rows,
// no override changes, no cache writes. Only questions whose base vector is
// already in eval_question_embeddings are timed, so no query is ever embedded —
// the same rule scripts/fusion-equiv.ts uses to stay at $0. Safe to point at the
// live master config.
//
// WHAT IT DOES NOT MEASURE: the judging, the inserts, and the baseline leg's
// bookkeeping. Those are real parts of a re-score, but they are not the fusion
// path, and mixing them in is how a retrieval number stops being one.
//
// IT RUNS INSIDE A DETACHED QUEUE, which is not decoration. The savings-ledger
// writes on this path (meterEmbedHitsByChars, meterEmbeds) go through
// lib/detached: inside a request they are QUEUED and flushed after the response,
// so they cost the user nothing — outside one they run inline. A driver without
// the queue therefore measures ~180 telemetry writes a real visitor never waits
// for, and reports a latency the app does not have. The queue here is installed
// with a no-op scheduler: the tasks are collected and dropped, because this
// script must not write.
import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { sql as scoped } from "../lib/db";
import { activeConfig } from "../lib/rag/activeConfig";
import { getActiveCriteria, retrievalDepth } from "../lib/rag/evalSettingsStore";
import { getCachedQueryEmbeddings } from "../lib/rag/evalStore";
import { listOverrides, overrideSims } from "../lib/rag/overrideStore";
import {
  buildRetrievalContext,
  prefetchRetrieval,
  retrieveWithCutoffs,
} from "../lib/rag/retriever";
import { poolDocSims, queryExcludingIds } from "../lib/rag/vectorStore";
import { embedQueryCached } from "../lib/rag/embedCache";
import { sameVectorSpace } from "../lib/rag/embeddingModels";
import { retrievalStateFingerprint } from "../lib/rag/overrideStore";
import { withDetachedQueue } from "../lib/detached";
import { CONFIG_ID, inScope, loadOwner } from "./lib/followup";

const raw = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});

// The eval scorer's own worker count (lib/rag/eval.SCORE_CONCURRENCY). Matched
// deliberately: a per-question latency measured alone is not the latency a
// re-score sees, because four workers contend for the same connection pool.
const CONCURRENCY = Number(process.env.TIMING_CONCURRENCY ?? 4);
const SAMPLE = Number(process.env.TIMING_SAMPLE ?? 60);

const ms = (n: number) => `${n.toFixed(1)} ms`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const out = await fn();
  return [out, performance.now() - t0];
}

// Same board selection as fusion-equiv: labelled questions of this config,
// ordered by id, cached vectors only.
async function board(n: number) {
  const cfg = activeConfig();
  const rows = await scoped<{ question_id: string; question: string }[]>`
    select distinct q.id as question_id, q.question
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${cfg.id}
    order by q.id
  `;
  const vectors = await getCachedQueryEmbeddings(
    rows.map((r) => r.question_id),
    cfg.embeddingModel,
  );
  return rows
    .filter((r) => vectors.has(r.question_id))
    .slice(0, n)
    .map((r) => ({ ...r, vector: vectors.get(r.question_id)! }));
}

async function main() {
  const owner = await loadOwner(raw);
  await inScope(owner, () =>
    withDetachedQueue(owner, () => {}, async () => {
    const cfg = activeConfig();
    const questions = await board(SAMPLE);
    if (questions.length === 0) throw new Error("no labelled questions with cached vectors");

    const overrides = await listOverrides();
    const models = [...new Set(overrides.map((o) => o.model))];
    const foreign = models.filter((m) => !sameVectorSpace(m, cfg.embeddingModel));
    console.log(
      `config ${CONFIG_ID}\n` +
        `  base model      ${cfg.embeddingModel}\n` +
        `  questions       ${questions.length} (of ${SAMPLE} asked for)\n` +
        `  override models ${models.length ? models.join(", ") : "none"}\n` +
        `  foreign lanes   ${foreign.length ? foreign.join(", ") : "none — this config never opens one"}\n` +
        `  concurrency     ${CONCURRENCY}\n`,
    );

    const criteria = await getActiveCriteria();
    const depth = retrievalDepth(criteria, cfg.topK);
    const statePromise = retrievalStateFingerprint();

    // --- the whole path, as the scorer runs it -------------------------------
    //
    // Twice: once with a cold context (every read per question, which is what
    // this cost before docs/fusion-latency-plan.md §3) and once prefetched (what
    // the scorer does now). A fresh context each time, or the second pass would
    // be reading the first's memos and measuring nothing.
    const pass = async (prefetch: boolean) => {
      const ctx = await buildRetrievalContext(statePromise);
      const [, prefetchMs] = await timed(async () => {
        if (prefetch) {
          await prefetchRetrieval(
            ctx,
            questions.map((q) => ({ text: q.question, vector: q.vector })),
            depth,
          );
        }
      });
      const per: number[] = [];
      const got: { ids: string[]; scores: number[]; cutoffs: unknown }[] = [];
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < questions.length; i = next++) {
          const q = questions[i];
          const [out, took] = await timed(() =>
            retrieveWithCutoffs(q.question, q.vector, depth, ctx),
          );
          per[i] = took;
          got[i] = {
            ids: out.retrieved.map((r) => r.chunk.chunk.id),
            scores: out.retrieved.map((r) => r.score),
            cutoffs: out.cutoffs,
          };
        }
      };
      const [, wall] = await timed(() =>
        Promise.all(Array.from({ length: Math.min(CONCURRENCY, questions.length) }, worker)),
      );
      const sorted = [...per].sort((a, b) => a - b);
      console.log(
        `${prefetch ? "PREFETCHED" : "per question"} — retrieveWithCutoffs over ${questions.length} question(s)\n` +
          (prefetch ? `  prefetch        ${(prefetchMs / 1000).toFixed(1)} s\n` : "") +
          `  wall            ${((wall + prefetchMs) / 1000).toFixed(1)} s\n` +
          `  per question    ${ms((wall + prefetchMs) / questions.length)} of wall, ` +
          `median latency ${ms(sorted[Math.floor(sorted.length / 2)])}, ` +
          `p95 ${ms(sorted[Math.floor(sorted.length * 0.95)])}\n`,
      );
      return { ms: wall + prefetchMs, got };
    };
    const cold = await pass(false);
    const warm = await pass(true);
    console.log(`  speedup         ${(cold.ms / warm.ms).toFixed(1)}x\n`);

    // THE CHECK THAT MAKES THE SPEEDUP MEANINGFUL. A prefetch that changed an
    // answer would not be an optimisation, so the two passes are compared
    // outright: same retrieved ids in the same order, same scores, same stored
    // cutoffs (they are persisted with the result and the dirty screen reasons
    // over them). Scores are compared exactly — both passes read the same float4
    // through the same operator, so a difference here is a different ROW, not a
    // rounding one.
    let bad = 0;
    for (let i = 0; i < questions.length; i++) {
      const a = cold.got[i];
      const b = warm.got[i];
      const same =
        a.ids.join(",") === b.ids.join(",") &&
        a.scores.join(",") === b.scores.join(",") &&
        JSON.stringify(a.cutoffs) === JSON.stringify(b.cutoffs);
      if (!same) {
        bad += 1;
        console.log(`  MISMATCH  q="${questions[i].question.slice(0, 60)}"`);
      }
    }
    console.log(
      bad === 0
        ? `  equivalence     ${questions.length}/${questions.length} identical (ids, scores and cutoffs)\n`
        : `  equivalence     ${bad} MISMATCHED — the prefetch changed an answer\n`,
    );
    if (bad > 0) process.exitCode = 1;
    const ctx = await buildRetrievalContext(statePromise);

    // --- the legs, one question, serially, so they add up --------------------
    const q = questions[0];
    const [baseChunks, annMs] = await timed(() =>
      queryExcludingIds(q.vector, Math.max(depth * 4, 200), overrides.map((o) => o.sourceChunkId)),
    );
    console.log(`one question's legs (serial, warm)\n  base ANN        ${ms(annMs)}`);
    for (const model of models) {
      const isBase = sameVectorSpace(model, cfg.embeddingModel);
      const [qv, qvMs] = await timed(() =>
        isBase ? Promise.resolve(q.vector) : embedQueryCached(q.question, model),
      );
      const [, simsMs] = await timed(() => overrideSims(model, qv));
      let poolMs = 0;
      if (!isBase) {
        [, poolMs] = await timed(() =>
          poolDocSims(baseChunks.map((c) => c.chunk.chunk.id), model, qv),
        );
      }
      console.log(
        `  ${model.padEnd(15)} query vector ${ms(qvMs)}, overrideSims ${ms(simsMs)}` +
          (isBase ? "  (base space — no pool read)" : `, poolDocSims ${ms(poolMs)}`),
      );
    }
    }),
  );
  await raw.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
