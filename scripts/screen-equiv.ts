// DEMO EGRESS PHASE 4 — equivalence check for the dirty screen's SQL sims.
//
//   npm run screen:equiv          replay screenAffectedQuestions both ways
//
// docs/demo-egress-plan.md §1.4 moved the screen's two cosines per (question,
// changed chunk) pair into Postgres. Nothing about WHAT is computed changed, so
// the risk is that something changed anyway — a float, or a pair the SQL joins
// resolve differently from the JS caches.
//
// The assertion is the screen's VERDICT, not the sim (§3). A sim here is an input
// to `screenStoredResult`'s >= comparisons and is never stored; what is stored is
// dirty-or-clean per question. So this runs the whole screen twice over the same
// changed set — once with the OLD prefetch-and-cosine-in-JS provider injected,
// once with the shipped SQL one — and compares the two verdict sets question by
// question.
//
// The bias is asymmetric on purpose (§3, §1.4): the screen fails toward a
// re-score, so SQL marking MORE questions dirty than JS is a performance
// regression worth logging, while SQL marking FEWER is a correctness bug and
// exits non-zero. A missing vector must stay null and null must stay dirty.
//
// The old JS provider is written out inline here rather than imported, for the
// same reason scripts/fusion-equiv.ts spells out its own: it has been deleted
// from the app, so a check that called into the app would stop comparing two
// implementations the moment it did. This file is the only surviving copy.
//
// Costs $0: every lookup on both sides is cache-only, and a miss means "dirty",
// never "embed it".
import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { sql as scoped } from "../lib/db";
import { activeConfig } from "../lib/rag/activeConfig";
import { cachedQueryVectors, cosine } from "../lib/rag/embedCache";
import { sameVectorSpace } from "../lib/rag/embeddingModels";
import {
  screenAffectedQuestions,
  sqlScreenSims,
  type ChangedChunk,
  type ScreenSimsFor,
} from "../lib/rag/eval";
import { screenStoredResult } from "../lib/rag/dirtyScreen";
import { getActiveCriteria, retrievalDepth } from "../lib/rag/evalSettingsStore";
import {
  allLabeledQuestions,
  getCachedQueryEmbeddings,
  latestResultsForScreening,
} from "../lib/rag/evalStore";
import { overrideEmbeddings, retrievalStateFingerprint } from "../lib/rag/overrideStore";
import { chunkEmbeddings } from "../lib/rag/vectorStore";
import { CONFIG_ID, inScope, loadOwner } from "./lib/followup";

const raw = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});

// The changed set: the first n overridden chunks by id — the SAME set the
// meter's screen leg walks (scripts/egress-meter.ts legScreen), so the two
// instruments are looking at one board.
const SAMPLE = Number(process.env.EQUIV_SAMPLE ?? 25);

// The OLD path, verbatim: every labelled question's query vector, every changed
// chunk's base vector, every piece under each model, all cosined in JS.
const jsScreenSims: ScreenSimsFor = async (changed, questions) => {
  const cfg = activeConfig();
  const baseQVecs = await getCachedQueryEmbeddings(
    questions.map((q) => q.questionId),
    cfg.embeddingModel,
  );
  const models = [...new Set(changed.flatMap((c) => (c.finalModel ? [c.finalModel] : [])))];
  const modelQVecs = new Map<string, Map<string, number[]>>();
  for (const m of models) {
    if (!sameVectorSpace(m, cfg.embeddingModel)) {
      modelQVecs.set(m, await cachedQueryVectors(questions.map((q) => q.question), m));
    }
  }
  const piecesByChunk = new Map<string, number[][]>();
  for (const m of models) {
    const wanted = changed.filter((c) => c.finalModel === m).map((c) => c.chunkId);
    const pieces = await overrideEmbeddings(m, wanted);
    for (const chunkId of wanted) {
      piecesByChunk.set(
        chunkId,
        pieces.filter((p) => p.chunkId === chunkId).map((p) => p.embedding),
      );
    }
  }
  const chunkBaseVecs = await chunkEmbeddings(changed.map((c) => c.chunkId));

  return (q) => {
    const qBase = baseQVecs.get(q.questionId) ?? null;
    return changed.map((x) => {
      const xBase = chunkBaseVecs.get(x.chunkId) ?? null;
      const baseSim = qBase && xBase ? cosine(qBase, xBase) : null;
      let bestPieceSim: number | null = null;
      if (x.finalModel !== null) {
        const qv = sameVectorSpace(x.finalModel, cfg.embeddingModel)
          ? qBase
          : (modelQVecs.get(x.finalModel)?.get(q.question) ?? null);
        const pieces = piecesByChunk.get(x.chunkId);
        if (qv && pieces && pieces.length > 0) {
          bestPieceSim = pieces.reduce((best, p) => Math.max(best, cosine(qv, p)), -Infinity);
        }
      }
      return { ...x, baseSim, bestPieceSim };
    });
  };
};

async function changedSet(n: number): Promise<ChangedChunk[]> {
  const rows = await scoped<{ source_chunk_id: string; model: string }[]>`
    select distinct on (source_chunk_id) source_chunk_id, model
    from config_chunk_overrides
    where config_id = ${activeConfig().id}
    order by source_chunk_id, piece_index
    limit ${n}
  `;
  return rows.map((r) => ({
    chunkId: r.source_chunk_id,
    finalModel: r.model,
    startOverridden: true,
  }));
}

// THE GATE, and why it is not simply "run the screen twice".
//
// screenAffectedQuestions skips a question whose stored result already carries the
// FINAL fingerprint — and on a board where no override has moved since the last
// re-score, that is every question, so both runs return 0/0/472 without consuming
// a single sim. A vacuous pass is worse than no check.
//
// So the verdict comparison is driven directly against the pure screen, with
// `startState` taken from the stored row itself: "this run started at the state
// this result was scored under", which is the situation the screen exists for and
// the only one in which its guards let it reach the sims at all. Both providers
// see identical stored rows; the ONLY difference is where the two cosines came
// from.
async function compareVerdicts(changed: ChangedChunk[]): Promise<{
  onlyJsDirty: string[];
  onlySqlDirty: string[];
  screened: number;
  pairs: number;
  jsNulls: number;
  sqlNulls: number;
  worstDrift: number;
  jsDirty: number;
  pgDirty: number;
}> {
  const cfg = activeConfig();
  const depth = retrievalDepth(await getActiveCriteria(), cfg.topK);
  const questions = await allLabeledQuestions();
  const latest = await latestResultsForScreening(await retrievalStateFingerprint());

  const jsFor = await jsScreenSims(changed, questions);
  const pgFor = await sqlScreenSims(changed, questions);

  const onlyJsDirty: string[] = [];
  const onlySqlDirty: string[] = [];
  let screened = 0;
  let pairs = 0;
  let jsNulls = 0;
  let sqlNulls = 0;
  let worstDrift = 0;
  // Reported because "0 disagreements" is only evidence if the verdicts were not
  // all one value: an all-dirty run would agree without ever depending on a sim.
  let jsDirty = 0;
  let pgDirty = 0;

  for (const q of questions) {
    const r = latest.get(q.labelId);
    if (!r || r.retrievalState === null) continue;
    const editStale = r.scoredAt === null || r.scoredAt < r.updatedAt;
    const jsSims = jsFor(q);
    const pgSims = pgFor(q);
    for (let i = 0; i < jsSims.length; i++) {
      pairs++;
      for (const key of ["baseSim", "bestPieceSim"] as const) {
        const a = jsSims[i][key];
        const b = pgSims[i][key];
        if (a === null) jsNulls++;
        if (b === null) sqlNulls++;
        if (a !== null && b !== null) worstDrift = Math.max(worstDrift, Math.abs(a - b));
      }
    }
    const args = {
      depth,
      baseModel: cfg.embeddingModel,
      // The run "started" where this result was scored — see the comment above.
      startState: r.retrievalState,
      retrievalState: r.retrievalState,
      editStale,
      retrievedIds: r.retrievedIds ?? [],
      cutoffs: r.screenCutoffs,
    };
    screened++;
    const js = screenStoredResult({ ...args, changed: jsSims });
    const pg = screenStoredResult({ ...args, changed: pgSims });
    if (js === "dirty") jsDirty++;
    if (pg === "dirty") pgDirty++;
    if (js === "dirty" && pg === "clean") onlyJsDirty.push(q.questionId);
    if (pg === "dirty" && js === "clean") onlySqlDirty.push(q.questionId);
  }
  return {
    onlyJsDirty, onlySqlDirty, screened, pairs, jsNulls, sqlNulls, worstDrift, jsDirty, pgDirty,
  };
}

async function main(): Promise<void> {
  const owner = await loadOwner(raw);
  let onlyJsDirty: string[] = [];
  let onlySqlDirty: string[] = [];

  await inScope(owner, async () => {
    const changed = await changedSet(SAMPLE);
    if (changed.length === 0) {
      throw new Error(`config ${CONFIG_ID.slice(0, 8)} has no overrides — nothing to screen`);
    }
    // "The run started now": the same start state the meter's leg uses, which is
    // the state that makes stored results screenable at all.
    const startState = await retrievalStateFingerprint();
    console.log(`${changed.length} changed chunk(s), start state ${startState.slice(0, 8)}`);

    const js = await screenAffectedQuestions(changed, startState, jsScreenSims);
    const pg = await screenAffectedQuestions(changed, startState);

    console.log(
      `js:  ${js.dirty.length} dirty / ${js.cleanLabelIds.length} proven clean / ${js.total} total`,
    );
    console.log(
      `sql: ${pg.dirty.length} dirty / ${pg.cleanLabelIds.length} proven clean / ${pg.total} total`,
    );
    const v = await compareVerdicts(changed);
    onlyJsDirty = v.onlyJsDirty;
    onlySqlDirty = v.onlySqlDirty;
    console.log(
      `verdicts: ${v.screened} question(s) screened over ${v.pairs} pair(s); ` +
        `dirty js ${v.jsDirty} / sql ${v.pgDirty}; ` +
        `nulls js ${v.jsNulls} / sql ${v.sqlNulls}; worst sim drift ` +
        `${v.worstDrift.toExponential(1)}`,
    );

    const jsClean = new Set(js.cleanLabelIds);
    const pgClean = new Set(pg.cleanLabelIds);
    const cleanDiff =
      [...jsClean].filter((id) => !pgClean.has(id)).length +
      [...pgClean].filter((id) => !jsClean.has(id)).length;
    console.log(`proven-clean label sets differ by ${cleanDiff} id(s)`);
  });

  // A question JS proved clean but SQL calls dirty is the safe direction: the
  // screen re-scores something it did not have to. The reverse is the bug.
  console.log(
    `\n${onlySqlDirty.length} dirty only under SQL (safe: an extra re-score), ` +
      `${onlyJsDirty.length} dirty only under JS (UNSAFE)`,
  );
  for (const id of onlyJsDirty.slice(0, 10)) console.log(`  UNSAFE ${id}`);
  await raw.end();
  process.exit(onlyJsDirty.length > 0 ? 1 : 0);
}

void main();
