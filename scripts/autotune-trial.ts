// ---------------------------------------------------------------------------
// TIMED AUTOTUNE TRIAL HARNESS (migration 0041).
//
// Runs autotune N times against an IDENTICAL workload and reports the per-phase
// wall clock, so a speed optimization can be judged against a real baseline
// rather than a memory of how long the last run felt.
//
// The problem it solves: autotune consumes its own workload. Targets are
// recomputed each run from the below-bar questions, and a run resolves some of
// them by applying overrides — so run 2 is faster than run 1 with no code
// change at all. Comparing a before to an after without controlling for that
// measures drift, not the optimization. Between runs the engine reverts every
// override it applied (lib/rag/autotune.resetForNextTrial, branch-only), and
// this script verifies the revert actually happened before starting the next
// run rather than trusting it.
//
//   Usage:  npm run dev            # in another terminal, port 3002
//           npm run trial -- --runs 3 --label baseline --warmup
//
// Run it through `npm run trial`, not bare tsx: the npm script passes
// --env-file=.env.local, and lib/db throws without DATABASE_URL (Next.js loads
// .env.local for the app, but a plain script gets nothing). The `--` is what
// forwards the flags past npm to the script.
//
//   --runs N        recorded runs (default 3). Three is the floor worth
//                   trusting: this work is network-bound with a long right
//                   tail, so a single run is not a measurement.
//   --label NAME    groups the runs in the Trial times tab (default 'baseline').
//   --config ID     config to run against (default: the app's Default config).
//   --warmup        one unrecorded run first, to warm embedding_cache. USE IT
//                   unless you are deliberately measuring cold embed latency —
//                   cold, provider variance drowns anything algorithmic.
//   --url URL       dev server base (default http://localhost:3002).
//
// Reports the MEDIAN, not the mean: one slow run drags a mean far enough to
// read as a regression that isn't there.
// ---------------------------------------------------------------------------
import { sql } from "../lib/db";

type DoneEvent = {
  type: "autotune-done";
  targeted: number;
  resolved: number;
  attempts: number;
  durationMs: number;
  phase: { search: number; confirm: number; rescore: number };
  // L8 diagnostics; absent on a server that predates them.
  confirms?: number;
  reverts?: number;
};





type ResetEvent = { type: "trial-reset"; overridesCleared: number; resultsPruned: number };
type ErrorEvent = { type: "error"; message: string };
type StreamEvent = DoneEvent | ResetEvent | ErrorEvent | { type: string };

type RunResult = {
  durationMs: number;
  search: number;
  confirm: number;
  rescore: number;
  other: number;
  targeted: number;
  attempts: number;
  resolved: number;
  confirms?: number;
  reverts?: number;
};

// --- args -------------------------------------------------------------------

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const RUNS = Number(arg("runs") ?? 3);
const LABEL = arg("label") ?? "baseline";
const BASE_URL = arg("url") ?? "http://localhost:3002";
const WARMUP = has("warmup");

// --- formatting -------------------------------------------------------------

const secs = (ms: number) => (ms / 1000).toFixed(1).padStart(7);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function printRow(label: string, r: RunResult): void {
  console.log(
    `  ${label.padEnd(9)} total ${secs(r.durationMs)}s   ` +
      `search ${secs(r.search)}  confirm ${secs(r.confirm)}  ` +
      `rescore ${secs(r.rescore)}  other ${secs(r.other)}`,
  );
}

// --- pre-flight -------------------------------------------------------------

// Every check here guards a way the measurement can be silently wrong. They
// abort rather than warn: a bad baseline is worse than no baseline, because it
// looks like a number.
async function preflight(configId: string): Promise<void> {
  const [cfg] = await sql<
    {
      name: string;
      mrr_min_rate: number | null;
      recall_min_rate: number | null;
      ndcg_min_rate: number | null;
      autotune_stop_early: boolean;
      autotune_keep_best: boolean;
      autotune_chunk_scope: string[] | null;
    }[]
  >`
    select name, mrr_min_rate, recall_min_rate, ndcg_min_rate,
           autotune_stop_early, autotune_keep_best, autotune_chunk_scope
    from configs where id = ${configId}
  `;
  if (!cfg) throw new Error(`No config ${configId}.`);

  const problems: string[] = [];

  // The engine refuses to run without a targeted metric at all.
  if (cfg.mrr_min_rate === null && cfg.recall_min_rate === null && cfg.ndcg_min_rate === null) {
    problems.push("no metric has a min-rate — autotune will refuse to run");
  }
  // stop_early halts the run once aggregate rates reach their bars, which makes
  // duration depend on how close you START to the bar. That moves between runs.
  if (cfg.autotune_stop_early) {
    problems.push("autotune_stop_early is ON — run duration becomes workload-dependent");
  }
  // A null scope means "every chunk", so the target set follows whatever is
  // currently below bar. Pinning it fixes the workload independent of outcomes.
  if (cfg.autotune_chunk_scope === null) {
    problems.push(
      "autotune_chunk_scope is unset (all chunks) — pin a chunk set in " +
        "Settings → Autotuning so the workload can't drift",
    );
  }
  // Leftovers from an interrupted run mean the first run starts pre-resolved.
  const [{ count }] = await sql<{ count: string }[]>`
    select count(*) from config_chunk_overrides where config_id = ${configId}
  `;
  if (Number(count) > 0) {
    problems.push(`${count} override piece(s) already applied — start from a clean baseline`);
  }

  if (problems.length > 0) {
    console.error(`\nPre-flight failed for config "${cfg.name}":`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("");
    process.exit(1);
  }

  // Not a failure — a fork in what you're profiling, so it goes in the log.
  console.log(
    `config "${cfg.name}"  keepBest=${cfg.autotune_keep_best ? "ON" : "off"} ` +
      `(${cfg.autotune_keep_best ? "profiles confirm+rescore" : "profiles search"})  ` +
      `chunks=${cfg.autotune_chunk_scope?.length ?? "?"}\n`,
  );
}

// --- one run ----------------------------------------------------------------

async function runOnce(configId: string, label: string | null): Promise<RunResult> {
  const res = await fetch(`${BASE_URL}/api/eval/autotune`, {
    method: "POST",
    headers: {
      "x-config-id": configId,
      ...(label ? { "x-trial-label": label } : {}),
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`POST /api/eval/autotune failed (${res.status}). Is the dev server up?`);
  }

  let done: DoneEvent | null = null;
  let reset: ResetEvent | null = null;
  let buffer = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // NDJSON: one event per line, but a chunk can split a line, so the tail is
  // carried forward rather than parsed.
  for (;;) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as StreamEvent;
      if (evt.type === "error") throw new Error((evt as ErrorEvent).message);
      if (evt.type === "autotune-done") done = evt as DoneEvent;
      if (evt.type === "trial-reset") reset = evt as ResetEvent;
    }
  }

  if (!done) throw new Error("Stream ended without an autotune-done event.");
  if (!reset) {
    throw new Error(
      "Run finished without a trial-reset event. The always-revert in " +
        "lib/rag/autotune.resetForNextTrial is missing — without it every " +
        "later run faces a smaller workload and the timings are worthless.",
    );
  }

  const { search, confirm, rescore } = done.phase;
  return {
    durationMs: done.durationMs,
    search,
    confirm,
    rescore,
    other: Math.max(0, done.durationMs - search - confirm - rescore),
    targeted: done.targeted,
    attempts: done.attempts,
    resolved: done.resolved,
    confirms: done.confirms,
    reverts: done.reverts,
  };
}

// Trust but verify: the engine says it reverted, the DB confirms it. A silent
// failure here is exactly the drift this harness exists to prevent.
async function assertClean(configId: string): Promise<void> {
  const [{ count }] = await sql<{ count: string }[]>`
    select count(*) from config_chunk_overrides where config_id = ${configId}
  `;
  if (Number(count) > 0) {
    throw new Error(`Reset failed: ${count} override piece(s) survived. Aborting.`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  const explicit = arg("config");
  // Mirrors activeConfig.resolveDefaultConfig: there's no is_default flag, the
  // earliest-created config IS the default. Same rule, so --config-less runs hit
  // the same config the dev server would pick on its own.
  const [cfg] = explicit
    ? await sql<{ id: string }[]>`select id from configs where id = ${explicit}`
    : await sql<{ id: string }[]>`select id from configs order by created_at limit 1`;
  if (!cfg) throw new Error("No config found. Pass --config <id>.");

  await preflight(cfg.id);

  if (WARMUP) {
    console.log("warmup   (not recorded — warming embedding_cache)");
    const w = await runOnce(cfg.id, null);
    await assertClean(cfg.id);
    printRow("warmup", w);
    console.log("");
  }

  const results: RunResult[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce(cfg.id, LABEL);
    await assertClean(cfg.id);
    results.push(r);
    printRow(`run ${i}/${RUNS}`, r);
    if (r.confirms !== undefined) {
      // L8: revert rate says whether the search is over-promising — i.e.
      // whether confirm cycles are being spent to reject bad candidates.
      console.log(
        `             confirms=${r.confirms} reverts=${r.reverts}` +
          ` (${r.confirms ? Math.round((r.reverts! / r.confirms) * 100) : 0}%)`,
      );
    }
  }

  console.log("");
  printRow("MEDIAN", {
    durationMs: median(results.map((r) => r.durationMs)),
    search: median(results.map((r) => r.search)),
    confirm: median(results.map((r) => r.confirm)),
    rescore: median(results.map((r) => r.rescore)),
    other: median(results.map((r) => r.other)),
    targeted: results[0].targeted,
    resolved: results[0].resolved,
    attempts: results[0].attempts,
  });


  // The workload check. If these moved, the runs weren't comparable and the
  // median above is an average of different jobs — say so loudly.
  const targeted = new Set(results.map((r) => r.targeted));
  const attempts = new Set(results.map((r) => r.attempts));
  console.log(
    `\n  workload  targeted=${[...targeted].join("/")} attempts=${[...attempts].join("/")}`,
  );
  if (targeted.size > 1 || attempts.size > 1) {
    console.log(
      "  ⚠ WORKLOAD DRIFTED between runs — these timings are NOT comparable.\n" +
        "    Check that the reset ran and that chunk scope is pinned.",
    );
  }

  const spread = (Math.max(...results.map((r) => r.durationMs)) /
    Math.min(...results.map((r) => r.durationMs)) -
    1) * 100;
  console.log(`  spread    ${spread.toFixed(1)}% between fastest and slowest run`);
  if (spread > 10) {
    console.log("  ⚠ Over 10% — something uncontrolled is in the measurement.");
  }

  // The Trial times tab that used to render these is gone; the timings still
  // land in autotune_runs (0041), so read them from there.
  console.log(
    `\n  saved as trial '${LABEL}' (${RUNS} runs) → autotune_runs.trial_label\n`,
  );
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(`\n${err instanceof Error ? err.message : err}\n`);
    await sql.end();
    process.exit(1);
  });
