// FUSION EGRESS PHASE 2 — equivalence check for the override-sim change.
//
//   npm run fusion:equiv          compare the JS piece loop against SQL sims
//
// docs/fusion-egress-plan.md §3: neither fix in that plan changes WHAT is
// computed, so the only real risk is that one changes it anyway, by a float.
// `max(1 - (embedding <=> qv::vector))` in Postgres and "cosine every
// piece in JS, keep the max" sum the same float4 values in different orders, and
// the precedent (scripts/cache-probe-equiv.ts) measured that disagreement once
// already: ~1e-7, because the server runs extra_float_digits = 0 and a `real`
// does not round-trip through its text form.
//
// So this replays real questions through fuseWithOverrides TWICE — once with the
// old JS piece loop injected as `simsFor`, once with the shipped SQL reader — and
// asserts the MERGED RANK ORDER is identical position for position, sims agreeing
// within 1e-6. Rank order is the assertion that matters: a sim is informational
// (retriever.ts), a rank is what gets stored, and rank equality is the evidence
// DECISION 2 (do not bump FUSION_VERSION) rests on.
//
// 1e-6 is deliberately TIGHTER than the precedent's 1e-5: that script compares a
// real[] JS path against pgvector over vectors from DIFFERENT rows, while this one
// compares the same float4 values summed in two orders. An order of magnitude of
// headroom over the measured ~1e-7, and it still fails loudly on a real
// divergence.
//
// The old JS path is written out inline here rather than imported, for the same
// reason the cache precedent did: it is being deleted from the app, so a check
// that called into the app would stop comparing two implementations the moment it
// did. This file is the only surviving copy.
//
// Costs $0: only questions whose base vector is already in
// eval_question_embeddings are replayed, and the master's overrides are all
// base-space folds, so no query is ever embedded.
import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { sql as scoped } from "../lib/db";
import { activeConfig } from "../lib/rag/activeConfig";
import { cosine } from "../lib/rag/embedCache";
import { getActiveCriteria, retrievalDepth } from "../lib/rag/evalSettingsStore";
import { getCachedQueryEmbeddings } from "../lib/rag/evalStore";
import { listOverrides, overrideEmbeddings, overrideSims } from "../lib/rag/overrideStore";
import { fuseWithOverrides, type FusedCandidate } from "../lib/rag/retriever";
import { CONFIG_ID, inScope, loadOwner } from "./lib/followup";

const raw = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});

const SAMPLE = Number(process.env.EQUIV_SAMPLE ?? 25);
const TOL = 1e-6;

// The OLD path, verbatim: every piece vector under the model to the app, cosine
// in JS, keep the max per source chunk.
async function simsViaJs(model: string, qv: number[]): Promise<Map<string, number>> {
  const pieces = await overrideEmbeddings(model);
  const best = new Map<string, number>();
  for (const p of pieces) {
    const sim = cosine(qv, p.embedding);
    const prev = best.get(p.chunkId);
    if (prev === undefined || sim > prev) best.set(p.chunkId, sim);
  }
  return best;
}

// Same questions the meter's fixed walk uses, and selected the same way (ordered
// by id, cached vectors only) so the two instruments are looking at one board.
async function sample(n: number) {
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

// Largest per-position sim gap between two merged lists, or null if the ORDER
// differs — an order difference is not a tolerance question.
function compare(js: FusedCandidate[], pg: FusedCandidate[]): { sameOrder: boolean; drift: number } {
  if (js.length !== pg.length) return { sameOrder: false, drift: Infinity };
  let drift = 0;
  for (let i = 0; i < js.length; i++) {
    if (js[i].id !== pg[i].id) return { sameOrder: false, drift: Infinity };
    drift = Math.max(drift, Math.abs(js[i].sim - pg[i].sim), Math.abs(js[i].rank - pg[i].rank));
  }
  return { sameOrder: true, drift };
}

async function main(): Promise<void> {
  const owner = await loadOwner(raw);
  let compared = 0;
  let mismatched = 0;
  let worst = 0;

  await inScope(owner, async () => {
    const cfg = activeConfig();
    const overrides = await listOverrides();
    if (overrides.length === 0) {
      throw new Error(`config ${CONFIG_ID.slice(0, 8)} has no overrides — nothing to fuse`);
    }
    const questions = await sample(SAMPLE);
    if (questions.length === 0) throw new Error("no questions with a cached vector to replay");
    const k = retrievalDepth(await getActiveCriteria(), cfg.topK);
    console.log(
      `${questions.length} questions, ${overrides.length} overrides, depth ${k}, tolerance ${TOL}`,
    );

    for (const q of questions) {
      const js = await fuseWithOverrides(q.question, q.vector, k, overrides, (m, qv) =>
        simsViaJs(m, qv),
      );
      const pg = await fuseWithOverrides(q.question, q.vector, k, overrides, (m, qv) =>
        overrideSims(m, qv),
      );
      compared++;
      const { sameOrder, drift } = compare(js.merged, pg.merged);
      const ok = sameOrder && drift <= TOL;
      if (!ok) mismatched++;
      if (sameOrder) worst = Math.max(worst, drift);
      console.log(
        `${ok ? "ok  " : "FAIL"} ${String(js.merged.length).padStart(4)} candidates  ` +
          `${sameOrder ? `Δmax=${drift.toExponential(1)}` : "ORDER DIFFERS"}  ` +
          `q="${q.question.slice(0, 55)}"`,
      );
      if (!sameOrder) {
        console.log(`     js: ${js.merged.slice(0, 8).map((c) => c.id.slice(0, 8)).join(" ")}`);
        console.log(`     pg: ${pg.merged.slice(0, 8).map((c) => c.id.slice(0, 8)).join(" ")}`);
      }
    }
  });

  console.log(
    `\n${compared} replayed — ${mismatched} mismatched, worst same-order drift ` +
      `${worst.toExponential(1)} (tolerance ${TOL})`,
  );
  await raw.end();
  process.exit(mismatched > 0 ? 1 : 0);
}

void main();
