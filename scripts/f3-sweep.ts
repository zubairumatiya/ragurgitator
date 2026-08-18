// FOLLOW-UP F3, last step — run the cache-key model sweep to completion.
//
//   npm run f3:sweep -- run [--pre] [--only <model>] [--force]
//   npm run f3:sweep -- report      print both leaderboards and the delta
//   npm run f3:sweep -- coverage    per-model warmth of the sweep's own text set
//
// WHY A DRIVER AND NOT THE PANEL. The sweep is the same code either way
// (runKeyModelSweep); what differs is what survives an interruption. The panel
// hands back one JSON blob after ~an hour and nothing before it, so a run that
// dies at model nine leaves no leaderboard at all — the vectors are banked, but
// the scores have to be re-derived by running again. Here each model is scored
// and CHECKPOINTED to disk as it finishes, so `run` is resumable and an
// interrupted hour still reports every model it got through.
//
// ONE MODEL AT A TIME IS THE SAME SWEEP. scoreModel embeds only its own model's
// texts and calibrates on the shared pooled pair set, with no cross-model state,
// so eleven single-candidate calls produce the same eleven rows as one
// eleven-candidate call. The only thing lost is the server's sort, which `report`
// redoes on the same key (recall@τ desc, AUC tiebreak).
//
// CANCELLATION IS A FLAG, never a throw — the repo convention, and the reason
// this is safe to leave running. SIGINT sets it; the in-flight model finishes its
// current provider call, reports unscored, and every vector already bought stays
// persisted (embedQueryCached writes through). A second SIGINT is the escape
// hatch if a provider call is wedged.
//
// TWO PAIR SETS, one embedding pass. `run` scores the post-quarantine set (165
// pairs — what the sweep actually consumes); `run --pre` scores the same models
// on all 180 including F3's 15 quarantined rows. That second pass is nearly free
// once the cache is warm, and it is the only way to answer whether the quarantine
// moved the ranking — the pre-quarantine leaderboard was never recorded, because
// the run that would have produced it was SIGKILLed after one model.
//
// COST is embedding-only and one-time: ~$0.02 and ~60 minutes on a cold cache,
// seconds on a warm one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { config as appConfig } from "../lib/config";
import { runKeyModelSweep, type LeaderboardRow, type SweepResult } from "../lib/rag/keyModelSweep";
import { scopedAcceptTarget } from "../lib/rag/semanticCache";
import { inScope, loadOwner, type Owner } from "./lib/followup";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });

let owner: Owner;

// Checkpoint files. docs/ is gitignored by design — these are run outputs, not
// source. `pre` is the with-quarantine comparison; `post` is the real sweep.
const FILE = (pre: boolean) =>
  pre ? "docs/resume-metrics-f3-sweep-pre.json" : "docs/resume-metrics-f3-sweep.json";

type Checkpoint = {
  startedAt: string;
  updatedAt: string;
  includeQuarantined: boolean;
  target: number | null;
  pairs: SweepResult["pairs"] | null;
  // Keyed by model so a re-run replaces a row instead of appending a second one.
  rows: Record<string, LeaderboardRow>;
};

const load = (pre: boolean): Checkpoint => {
  const path = FILE(pre);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  const now = new Date().toISOString();
  return {
    startedAt: now,
    updatedAt: now,
    includeQuarantined: pre,
    target: null,
    pairs: null,
    rows: {},
  };
};

const save = (pre: boolean, cp: Checkpoint): void => {
  cp.updatedAt = new Date().toISOString();
  writeFileSync(FILE(pre), `${JSON.stringify(cp, null, 2)}\n`);
};

// A row counts as done only if it actually carries a score or a permanent
// reason (unavailable, unknown model). A "not scored — cancelled" row is a
// placeholder and must be retried on the next run, or resuming would silently
// inherit the gap it was meant to fill.
const isDone = (row: LeaderboardRow): boolean =>
  row.recallAtThreshold !== null ||
  row.auc !== null ||
  (row.reason !== null && !row.reason.startsWith("not scored"));

const pct = (v: number | null): string => (v === null ? "  —  " : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, d = 4): string => (v === null ? "  —  " : v.toFixed(d));

function printLeaderboard(cp: Checkpoint, title: string): void {
  const rows = Object.values(cp.rows).sort(
    (a, b) =>
      (b.recallAtThreshold ?? -1) - (a.recallAtThreshold ?? -1) || (b.auc ?? -1) - (a.auc ?? -1),
  );
  const p = cp.pairs;
  console.log(
    `\n${title} — ${p ? `${p.total} pairs (${p.same} same / ${p.different} different, ` +
      `${p.generated} generated / ${p.shadow} shadow)` : "no pair counts"}` +
      `, target ${cp.target === null ? "?" : `${(cp.target * 100).toFixed(0)}%`}`,
  );
  console.table(
    rows.map((r) => ({
      model: r.model,
      "τ": num(r.threshold),
      "recall@τ": pct(r.recallAtThreshold),
      "precision@τ": pct(r.precisionAtThreshold),
      auc: num(r.auc, 4),
      scored: r.pairsScored,
      note: r.error ?? r.reason ?? "",
    })),
  );
}

// --- run ---------------------------------------------------------------------

async function run(pre: boolean, only: string | null, force: boolean): Promise<void> {
  const cp = load(pre);
  const candidates = only ? [only] : [...appConfig.semanticCache.keyModelSweep.candidates];
  const todo = candidates.filter((m) => force || !cp.rows[m] || !isDone(cp.rows[m]));

  console.log(
    `sweep${pre ? " (PRE-quarantine: all pairs)" : " (post-quarantine)"} — ` +
      `${todo.length} of ${candidates.length} model(s) to score` +
      (todo.length < candidates.length ? `, ${candidates.length - todo.length} already banked` : ""),
  );
  if (todo.length === 0) {
    printLeaderboard(cp, pre ? "PRE-quarantine" : "POST-quarantine");
    return;
  }

  let stopping = false;
  const onSigint = () => {
    if (stopping) {
      console.log("\nsecond interrupt — exiting now; banked vectors and rows are kept");
      process.exit(130);
    }
    stopping = true;
    console.log("\ninterrupt — finishing the current embedding, then stopping (rows are saved)");
  };
  process.on("SIGINT", onSigint);

  const target = await scopedAcceptTarget();
  cp.target = target.target;

  for (const model of todo) {
    if (stopping) break;
    const t0 = Date.now();
    process.stdout.write(`  ${model} … `);
    const result = await runKeyModelSweep(target, [model], () => stopping, {
      includeQuarantined: pre,
    });
    cp.pairs = result.pairs;
    const row = result.rows[0];
    cp.rows[model] = row;
    save(pre, cp);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    // A null recall is NOT a failure to score, and saying "no score" for it is how
    // an unattainable target gets misread as a broken model: the row still holds
    // an AUC over the full pair set, which is what the sweep ranks on when no τ
    // clears the target. Only a row with neither is actually missing.
    console.log(
      row.recallAtThreshold !== null
        ? `recall@τ ${pct(row.recallAtThreshold)} at τ ${num(row.threshold)} ` +
            `(precision ${pct(row.precisionAtThreshold)}, auc ${num(row.auc)}) — ${secs}s`
        : row.auc !== null
          ? `no τ clears the target — auc ${num(row.auc)} over ${row.pairsScored} pairs — ${secs}s`
          : `${row.error ?? row.reason ?? "no score"} — ${secs}s`,
    );
  }

  process.off("SIGINT", onSigint);
  printLeaderboard(cp, pre ? "PRE-quarantine" : "POST-quarantine");
  if (stopping) {
    console.log("\nstopped early — re-run `npm run f3:sweep -- run` to pick up the rest");
    process.exitCode = 130;
  }
}

// --- report ------------------------------------------------------------------

function report(): void {
  const post = existsSync(FILE(false)) ? load(false) : null;
  const pre = existsSync(FILE(true)) ? load(true) : null;
  if (post) printLeaderboard(post, "POST-quarantine (165 pairs — what the sweep serves)");
  if (pre) printLeaderboard(pre, "PRE-quarantine (180 pairs — F3's 15 bad rows put back)");
  if (!post || !pre) {
    console.log("\n(run both `run` and `run --pre` to get the delta)");
    return;
  }

  // The comparison that answers "did quarantining 15 mislabelled hard negatives
  // change which model we would pick". Rank movement is the headline; a ranking
  // that does NOT move is a real result, not a failed run.
  const rank = (cp: Checkpoint): string[] =>
    Object.values(cp.rows)
      .sort(
        (a, b) =>
          (b.recallAtThreshold ?? -1) - (a.recallAtThreshold ?? -1) || (b.auc ?? -1) - (a.auc ?? -1),
      )
      .map((r) => r.model);
  const preRank = rank(pre);
  const postRank = rank(post);

  console.log("\nDELTA (pre-quarantine → post-quarantine)");
  console.table(
    postRank.map((model, i) => {
      const before = pre.rows[model];
      const after = post.rows[model];
      const was = preRank.indexOf(model);
      return {
        model,
        rank: was === i ? `${i + 1}` : `${was + 1} → ${i + 1}`,
        "recall@τ": `${pct(before?.recallAtThreshold ?? null)} → ${pct(after.recallAtThreshold)}`,
        "τ": `${num(before?.threshold ?? null)} → ${num(after.threshold)}`,
        auc: `${num(before?.auc ?? null)} → ${num(after.auc)}`,
      };
    }),
  );
  console.log(
    preRank.join(",") === postRank.join(",")
      ? "\nranking UNCHANGED by the quarantine."
      : "\nranking MOVED — see the rank column.",
  );
}

// --- coverage ----------------------------------------------------------------

// The honest progress read, and the one the runbook insists on: embedding_cache
// row counts say nothing, because most rows in there are for texts this sweep
// never touches. This asks how much of the sweep's OWN text set each model holds.
async function coverage(): Promise<void> {
  const texts = await inScope(owner, async () => {
    const pairs = await (await import("../lib/rag/keyModelSweep")).pooledPairs();
    return [...new Set(pairs.flatMap((p) => [p.textA, p.textB]))];
  });
  const rows = await sql<{ model: string; cached: number }[]>`
    select m.model,
           (select count(*) from unnest(${texts}::text[]) as t(txt)
            where exists (
              select 1 from embedding_cache ec
              where ec.user_id = ${owner.id} and ec.model = m.model
                and ec.input_kind = 'query'
                and ec.text_hash = encode(digest(t.txt, 'sha256'), 'hex')))::int as cached
    from (select distinct model from embedding_cache where user_id = ${owner.id}) m
    order by cached desc`;
  console.log(`sweep text set: ${texts.length} distinct texts`);
  console.table(rows.map((r) => ({ model: r.model, cached: `${r.cached} / ${texts.length}` })));
}

async function main(): Promise<void> {
  owner = await loadOwner(sql);
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  switch (verb) {
    case "run":
      await inScope(owner, () => run(argv.includes("--pre"), only, argv.includes("--force")));
      break;
    case "report": report(); break;
    case "coverage": await coverage(); break;
    default:
      console.log(" verbs: run [--pre] [--only <model>] [--force] | report | coverage");
  }
}

// lib/db holds an open pool, so a script that merely returns hangs after printing.
main().then(async () => {
  await sql.end();
  process.exit(process.exitCode ?? 0);
}, async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
