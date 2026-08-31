// FUSION EGRESS PHASE 4a — replay the master's stored ranks, read-only.
//
//   npm run fusion:replay          replay every question still on the current
//                                  fingerprint and assert rank equality
//
// docs/fusion-egress-plan.md DECISION 6: the plan originally had phase 4 run a
// real re-score and an autotune on the master and compare recall/MRR/nDCG. That
// mutates the live eval board — new eval_results rows, a new eval_runs snapshot —
// to produce a summary statistic, when the thing actually being asserted is "the
// same candidates in the same order".
//
// `eval_results.retrieved_ids` already holds that order, stamped with the
// `retrieval_state` fingerprint it was scored under. So this replays the stored
// questions through the NEW path and asserts the returned id list equals the
// stored one POSITION FOR POSITION. That is both read-only and strictly stronger
// than the metrics: recall can hold at 86.7% while two chunks swap places, rank
// equality cannot.
//
// A question whose latest result predates the current fingerprint is SKIPPED, not
// failed — its overrides moved since, so a difference there means nothing about
// phases 2 and 3. The count of what was actually replayed is printed, because a
// pass over a handful of questions is not evidence and the log has to say so.
//
// Costs $0 and writes nothing: only questions whose base vector is already in
// eval_question_embeddings are replayed, so no query is ever embedded, and the
// only statements issued are selects.
//
// Run it under the meter (`npm run egress -- start` / `report`) — phase 4's
// budget is the whole point of taking this read-only route.
import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { sql as scoped } from "../lib/db";
import { activeConfig } from "../lib/rag/activeConfig";
import { getActiveCriteria, retrievalDepth } from "../lib/rag/evalSettingsStore";
import { getCachedQueryEmbeddings } from "../lib/rag/evalStore";
import { retrievalStateFingerprint } from "../lib/rag/overrideStore";
import { buildRetrievalContext, retrieveWithCutoffs } from "../lib/rag/retriever";
import { CONFIG_ID, inScope, loadOwner } from "./lib/followup";

const raw = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});

// Below this the phase is graded on a handful and the log must say so (§5, 4a).
const THIN = 50;

type Stored = {
  questionId: string;
  question: string;
  retrievedIds: string[];
  retrievalState: string | null;
  scoredAt: Date;
};

// The LATEST non-baseline result per label, whatever fingerprint it carries.
// Deliberately not filtered to the current fingerprint in SQL: a question whose
// newest result is stale must be counted as skipped, and a `where` clause would
// instead silently promote an older, current-looking row.
async function storedRanks(): Promise<Stored[]> {
  const cfg = activeConfig();
  const rows = await scoped<
    {
      question_id: string;
      question: string;
      retrieved_ids: string[] | null;
      retrieval_state: string | null;
      scored_at: Date;
    }[]
  >`
    select distinct on (l.id)
           q.id as question_id, q.question,
           r.retrieved_ids, r.retrieval_state, r.scored_at
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    join eval_results r on r.eval_label_id = l.id and not r.is_baseline
    where de.config_id = ${cfg.id}
    order by l.id, r.scored_at desc
  `;
  return rows
    .map((r) => ({
      questionId: r.question_id,
      question: r.question,
      retrievedIds: r.retrieved_ids ?? [],
      retrievalState: r.retrieval_state,
      scoredAt: r.scored_at,
    }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
}

// First position where the two lists differ, or -1. Length is compared first
// because a shorter list is a difference at its own end, not at position 0.
function firstDiff(stored: string[], replayed: string[]): number {
  const n = Math.min(stored.length, replayed.length);
  for (let i = 0; i < n; i++) if (stored[i] !== replayed[i]) return i;
  return stored.length === replayed.length ? -1 : n;
}

async function main(): Promise<void> {
  const owner = await loadOwner(raw);
  let replayed = 0;
  let mismatched = 0;
  let staleSkipped = 0;
  let noVector = 0;
  let empty = 0;

  await inScope(owner, async () => {
    const cfg = activeConfig();
    const state = await retrievalStateFingerprint();
    const depth = retrievalDepth(await getActiveCriteria(), cfg.topK);
    const all = await storedRanks();
    const current = all.filter((s) => s.retrievalState === state);
    staleSkipped = all.length - current.length;

    const vectors = await getCachedQueryEmbeddings(
      current.map((s) => s.questionId),
      cfg.embeddingModel,
    );

    console.log(
      `config ${CONFIG_ID.slice(0, 8)} — ${all.length} scored questions, ` +
        `${current.length} on the current fingerprint, depth ${depth}`,
    );
    console.log(`fingerprint: ${state.slice(0, 16)}…`);

    // One shared context: the re-score shape, which is what produced the stored
    // rows. A fresh context per question would assert the same thing at 25x the
    // override reads, and phase 4's budget is the reason 4a exists at all.
    const ctx = await buildRetrievalContext(Promise.resolve(state));

    for (const s of current) {
      const qv = vectors.get(s.questionId);
      if (!qv) {
        noVector++;
        continue;
      }
      if (s.retrievedIds.length === 0) {
        empty++;
        continue;
      }
      const { retrieved } = await retrieveWithCutoffs(s.question, qv, depth, ctx);
      const ids = retrieved.map((r) => r.chunk.chunk.id);
      replayed++;
      const diff = firstDiff(s.retrievedIds, ids);
      if (diff === -1) continue;
      mismatched++;
      console.log(
        `FAIL diverges at position ${diff + 1} of ${s.retrievedIds.length} ` +
          `q="${s.question.slice(0, 55)}"`,
      );
      console.log(`     stored:   ${s.retrievedIds.slice(0, 8).map((i) => i.slice(0, 8)).join(" ")}`);
      console.log(`     replayed: ${ids.slice(0, 8).map((i) => i.slice(0, 8)).join(" ")}`);
    }
  });

  console.log(
    `\n${replayed} replayed — ${mismatched} rank mismatches` +
      ` (skipped: ${staleSkipped} stale fingerprint, ${noVector} no cached vector, ${empty} empty result)`,
  );
  if (replayed < THIN) {
    console.log(
      `NOTE: fewer than ${THIN} questions replayed — this is a thin sample and the ` +
        `verification log must say so rather than grading the phase on a handful.`,
    );
  }
  await raw.end();
  process.exit(mismatched > 0 || replayed === 0 ? 1 : 0);
}

void main();
