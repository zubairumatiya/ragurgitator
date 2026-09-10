// AUTOTUNE PRESS TIMING — phase 1 of docs/autotune-press-latency-plan.md.
//
// The question is where a demo guest's ⚙ press spends its 225 seconds, and the
// candidates (H1–H6 there) cannot be told apart from the wall clock alone. This
// module stamps every stage of a press with its milliseconds and the number of
// SQL statements it issued, prints one line per chunk and one table at the end
// whose rows sum to the press's wall time, and does nothing at all unless
// AUTOTUNE_TIMING=1 is in the environment.
//
// PHASE 1 ONLY, AND REMOVABLE. Every hook is `stage(name, fn)`, which is `fn()`
// when the flag is off — so the shipped path is the call graph it was, plus one
// function frame per stage. scripts/guards.ts sweep 9 holds the gate and the
// allowlist of files that may import this, so the instrument cannot quietly
// become a feature. When phase 4 has what it needs, delete the module and the
// sweep together.
//
// No imports on purpose: lib/db.ts reaches for the statement counter, and a
// module lib/db.ts imports must not import lib/db.ts.
export const AUTOTUNE_TIMING = process.env.AUTOTUNE_TIMING === "1";

// Every statement postgres.js writes on the app pool, from lib/db.ts's `debug`
// hook. Process-wide, not per request: the dev server running a walk has one
// press in flight, and a stage's delta is what it issued. (A poll from another
// tab would land in whichever stage was open — read a surprising count with
// that in mind, and check the dev log for concurrent requests before believing
// it.)
//
// ON globalThis FOR THE REASON THE POOL IS: Next's dev server evaluates a module
// once per bundle graph, and lib/db.ts caches its pool on globalThis so the first
// graph's pool serves every later one. The pool's debug hook therefore closes
// over the FIRST graph's copy of this module; a module-level `let` here read 0
// from the route's copy for an entire 230-second press.
declare global {
  var __ragAutotuneStatements: { n: number } | undefined;
  var __ragAutotuneStack: Open[] | undefined;
  var __ragAutotuneSql: Map<string, Map<string, number>> | undefined;
}
const counter = (globalThis.__ragAutotuneStatements ??= { n: 0 });

// WHICH statements, not just how many: with AUTOTUNE_TIMING_SQL=1 as well, each
// statement's first line is tallied under the stage that was open, and the
// table is followed by one block per stage listing them. This is how a stage's
// count becomes a list of things to remove — phase 3's first cut found that a
// one-question prefetch's "8 statements" were two ANN reads each wrapped in
// begin / set local / select / commit.
// On globalThis for the same reason as the counter: the pool's hook tallies
// into the first bundle graph's copy of this map, and the route's copy prints
// it — the first census printed an empty block from a module-level Map. The
// stage stack is there too, because the hook reads it to find the open stage.
const SQL = process.env.AUTOTUNE_TIMING_SQL === "1";
const perStage = (globalThis.__ragAutotuneSql ??= new Map<string, Map<string, number>>());
function tally(query: string): void {
  const open = stack[stack.length - 1];
  const label = query.replace(/\s+/g, " ").trim().slice(0, 90);
  const m = perStage.get(open?.name ?? "(no stage)") ?? new Map<string, number>();
  m.set(label, (m.get(label) ?? 0) + 1);
  perStage.set(open?.name ?? "(no stage)", m);
}

export function countStatement(query?: string): void {
  counter.n += 1;
  if (SQL && AUTOTUNE_TIMING && typeof query === "string") tally(query);
}
const statementsSoFar = (): number => counter.n;

// NESTED STAGES SUM EXACTLY. A stage that contains other stages reports only the
// time its children did NOT account for, under "<name> (other)" — so every leaf
// plus every remainder adds up to the root, and the table's sum is the press's
// wall time by construction rather than by luck.
type Open = {
  name: string;
  t0: number;
  s0: number;
  childMs: number;
  childStmts: number;
};
const stack: Open[] = (globalThis.__ragAutotuneStack ??= []);

type Total = { ms: number; stmts: number; n: number };
const totals = new Map<string, Total>();

function add(name: string, ms: number, stmts: number): void {
  const t = totals.get(name) ?? { ms: 0, stmts: 0, n: 0 };
  t.ms += ms;
  t.stmts += stmts;
  t.n += 1;
  totals.set(name, t);
}

// One line per chunk: stages completed while a frame is open append to it
// instead of printing on their own.
type Frame = { label: string; fields: string[] };
let frame: Frame | null = null;

export async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!AUTOTUNE_TIMING) return fn();
  const open: Open = {
    name,
    t0: performance.now(),
    s0: statementsSoFar(),
    childMs: 0,
    childStmts: 0,
  };
  stack.push(open);
  try {
    return await fn();
  } finally {
    stack.pop();
    const ms = performance.now() - open.t0;
    const stmts = statementsSoFar() - open.s0;
    if (open.childMs === 0 && open.childStmts === 0) {
      add(name, ms, stmts);
    } else {
      add(`${name} (other)`, ms - open.childMs, stmts - open.childStmts);
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.childMs += ms;
      parent.childStmts += stmts;
    }
    const field = `${name}=${ms.toFixed(0)}ms/${stmts}`;
    if (frame) frame.fields.push(field);
    else console.log(`[rag:autotune:timing] ${field}`);
  }
}

export function openFrame(label: string): void {
  if (!AUTOTUNE_TIMING) return;
  frame = { label, fields: [] };
}

export function closeFrame(tail = ""): void {
  if (!AUTOTUNE_TIMING || !frame) return;
  console.log(
    `[rag:autotune:timing] ${frame.label} ${frame.fields.join(" ")}${tail ? ` ${tail}` : ""}`,
  );
  frame = null;
}

export function resetTimings(): void {
  totals.clear();
  perStage.clear();
  stack.length = 0;
  frame = null;
}

// The table the plan asks for: rows are stages, ms sums to the wall.
export function reportTimings(wallMs: number): void {
  if (!AUTOTUNE_TIMING) return;
  const rows = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms);
  const sumMs = rows.reduce((s, [, t]) => s + t.ms, 0);
  const sumStmts = rows.reduce((s, [, t]) => s + t.stmts, 0);
  const w = Math.max(...rows.map(([k]) => k.length), 5);
  const lines = rows.map(
    ([k, t]) =>
      `${k.padEnd(w)}  ${(t.ms / 1000).toFixed(1).padStart(7)} s  ` +
      `${String(t.stmts).padStart(6)} stmts  ${String(t.n).padStart(4)} calls  ` +
      `${(t.ms / t.n).toFixed(0).padStart(6)} ms/call  ` +
      `${((100 * t.ms) / wallMs).toFixed(1).padStart(5)}%`,
  );
  console.log(
    `[rag:autotune:timing] TABLE wall=${(wallMs / 1000).toFixed(1)}s ` +
      `staged=${(sumMs / 1000).toFixed(1)}s (${((100 * sumMs) / wallMs).toFixed(1)}%) ` +
      `statements=${sumStmts}\n` +
      lines.join("\n"),
  );
  if (!SQL) return;
  const blocks = [...perStage.entries()]
    .map(([stage, m]) => ({ stage, m, n: [...m.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.n - a.n)
    .map(
      ({ stage, m, n }) =>
        `-- ${stage}: ${n} statements\n` +
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([q, c]) => `   ${String(c).padStart(5)} × ${q}`)
          .join("\n"),
    );
  console.log(`[rag:autotune:timing] STATEMENTS\n${blocks.join("\n")}\n[rag:autotune:timing] END STATEMENTS`);
}

// `select 1` ten times in series through the scope's pinned connection: the
// round trip every statement on that connection pays (H6).
export async function sampleRtt(
  probe: () => Promise<unknown>,
  n = 10,
): Promise<void> {
  if (!AUTOTUNE_TIMING) return;
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await probe();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `[rag:autotune:timing] rtt n=${n} min=${samples[0].toFixed(1)}ms ` +
      `median=${samples[Math.floor(n / 2)].toFixed(1)}ms max=${samples[n - 1].toFixed(1)}ms`,
  );
}
