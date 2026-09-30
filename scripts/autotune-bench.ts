// AUTOTUNE PRESS BENCH — the before/after instrument for phases 3–4 of
// docs/autotune-press-latency-plan.md.
//
//   npm run autotune:bench -- run <label>            walk a fresh guest, record everything
//   npm run autotune:bench -- run <label> --presses 2   … then + medium → ⚙ as <label>-p2
//   npm run autotune:bench -- compare <a> <b>        diff two recorded runs, every difference
//   npm run autotune:bench -- gate <cut> <b1> <b2>…   the gate: outcomes + metrics identical,
//                                                    novel rank lists within the baselines' noise,
//                                                    and 0 retrieval-bank misses when a bank is there
//   npm run autotune:bench -- rekey <label>          re-read a saved run's outcomes + ranks
//   npm run autotune:bench -- list                   the runs recorded so far
//
// Phase 1 answered "where do the 222 seconds go" by hand: a curl-driven guest
// and a dev log read after the fact. Phase 3 removes fixed costs ONE AT A TIME
// and has to measure each, so the walk is a script and every run leaves a
// directory under data/autotune-bench/<label>/ with the same shape:
//
//   press.ndjson, add.ndjson, score.ndjson   the three streams, verbatim
//   timing.log                               every [rag:autotune:timing] line
//   summary.json                             wall, statements, RTT, the stage
//                                            table, the per-chunk outcomes, and
//                                            the guest's stored ranks
//   egress.txt                               the pg_stat_statements delta
//
// `compare` is the equivalence gate the plan's phases 2–3 name: identical
// per-chunk outcomes (which chunk kept what, keyed by document and position —
// chunk uuids are minted fresh per guest, so ids cannot be compared) and rank-
// for-rank identical retrieved lists on every question, plus the egress not
// rising. It exits non-zero when either equivalence fails, so a cut that got
// faster by changing the answer is a red run, not a fast one.
//
// Requires the dev server started with `AUTOTUNE_TIMING=1` and its stdout in
// the file --log names (default data/autotune-bench/dev.log). A run whose log
// delta has no TABLE line fails loudly rather than recording a wall time with
// no breakdown — that was phase 1's first mistake and it cost a 230 s walk.
//
// DO NOT EDIT lib/ WHILE A WALK IS RUNNING. The dev server recompiles on save,
// and although an in-flight request keeps the modules it loaded, a walk that
// straddles a recompile cannot be told apart from one that did not — the
// summary records the git head, not the code the server ran. Make the change,
// then walk it.
//
// Costs $0: Add cached hands out banked questions, Score pending embeds the
// guest's 30 questions once (the ledger's 60 calls, 1,518 tokens in phase 1 are
// Voyage-priced fractions of a cent), and the press is replayed from the bank.
import { spawnSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { modelSpec } from "../lib/rag/embeddingModels";
import { chunksTable } from "../lib/rag/vectorStore";

const ROOT = "data/autotune-bench";
const DEFAULT_LOG = join(ROOT, "dev.log");
const DEFAULT_BASE = "http://localhost:3002";

type StageRow = {
  stage: string;
  s: number;
  stmts: number;
  calls: number;
  msPerCall: number;
  share: number;
};

type Outcome = {
  key: string; // "<file>#<position>"
  chunkId: string;
  status: "published" | "unresolved";
  detail: string;
  pieces: number | null;
};

type Rank = {
  key: string; // "<file>#<position>::<question>"
  retrieved: string[]; // chunk keys, rank order
  hit: boolean;
  foundRank: number | null;
};

type Summary = {
  label: string;
  press?: number; // which lap on the guest this was (1 = the easy set)
  at: string;
  head: string;
  dirty: boolean;
  base: string;
  configId: string;
  rtt: { min: number; median: number; max: number } | null;
  addMs: number;
  scoreMs: number;
  scoreDone: Record<string, unknown> | null;
  pressMs: number;
  pressWallS: number | null; // the TABLE's wall=
  stagedS: number | null;
  statements: number | null;
  // Requests the server answered DURING the press that were not the press: the
  // statement counter is process-wide, so a browser tab polling /api/jobs adds
  // its statements to whichever stage was open. The two baselines saw 12 and
  // 16 polls and differed by 11 statements in 1,766 — read a per-stage stmts
  // delta smaller than this many × ~3 as jitter, not as a cut.
  otherRequests: number;
  stages: StageRow[];
  done: Record<string, unknown> | null;
  outcomes: Outcome[];
  ranks: Rank[];
  egressMb: number | null;
  // The demo's retrieval bank (docs/demo-retrieval-bank-plan.md §5), read off
  // the `retrieval bank read` log lines the server printed during Score
  // pending and during the press. Null when the server printed none — a guest
  // of a seed with no bank, or a build before the bank existed.
  bank: { scoreHits: number; scoreMisses: number; pressHits: number; pressMisses: number } | null;
};

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type Guest = { cookie: string; configId: string };

async function mintGuest(base: string): Promise<Guest> {
  // One guest per address per window: a spoofed private address per mint, the
  // same recipe as the plan's §5 and the demo plans before it.
  const ip = `10.${rnd(255)}.${rnd(255)}.${rnd(254) + 1}`;
  const res = await fetch(`${base}/api/demo/start`, {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
  if (!res.ok) throw new Error(`demo/start ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { redirect: string };
  const configId = body.redirect.replace(/^\/c\//, "");
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("demo/start set no cookie");
  return { cookie, configId };
}

const rnd = (n: number) => Math.floor(Math.random() * n);

async function stream(
  base: string,
  guest: Guest,
  path: string,
  body: unknown,
  outFile: string,
): Promise<{ ms: number; events: Record<string, unknown>[] }> {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}?configId=${guest.configId}`, {
    method: "POST",
    headers: { cookie: guest.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  writeFileSync(outFile, text);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 400)}`);
  const events = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const last = events[events.length - 1];
  if (last?.type === "error") throw new Error(`${path} streamed an error: ${JSON.stringify(last)}`);
  return { ms, events };
}

// ---------------------------------------------------------------------------
// The dev log: RTT line, per-chunk lines, the TABLE
// ---------------------------------------------------------------------------

const ROW =
  /^(\S.*?)\s{2,}([\d.]+) s\s+(\d+) stmts\s+(\d+) calls\s+(\d+) ms\/call\s+([\d.]+)%$/;

function parseTiming(lines: string[]): {
  rtt: Summary["rtt"];
  wall: number | null;
  staged: number | null;
  statements: number | null;
  stages: StageRow[];
} {
  let rtt: Summary["rtt"] = null;
  let wall: number | null = null;
  let staged: number | null = null;
  let statements: number | null = null;
  const stages: StageRow[] = [];
  let inTable = false;
  for (const line of lines) {
    const m = /rtt n=\d+ min=([\d.]+)ms median=([\d.]+)ms max=([\d.]+)ms/.exec(line);
    if (m) rtt = { min: +m[1], median: +m[2], max: +m[3] };
    const t = /TABLE wall=([\d.]+)s staged=([\d.]+)s .*statements=(\d+)/.exec(line);
    if (t) {
      wall = +t[1];
      staged = +t[2];
      statements = +t[3];
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const r = ROW.exec(line);
    if (!r) {
      inTable = false;
      continue;
    }
    stages.push({
      stage: r[1].trim(),
      s: +r[2],
      stmts: +r[3],
      calls: +r[4],
      msPerCall: +r[5],
      share: +r[6],
    });
  }
  return { rtt, wall, staged, statements, stages };
}

// ---------------------------------------------------------------------------
// Outcomes and ranks
// ---------------------------------------------------------------------------

// Keyed by the chunk's id, NAMED from the database afterwards: the chunk-start
// event carries "?" and null for a chunk whose targeted question is no longer
// failing when its turn comes (a kept install upstream moved it), and the two
// baseline walks announced 9 and 12 such chunks — keying by the event collapsed
// them into one "?#null" and the gate read three phantom differences.
// lib/log.ts's `{"msg":"retrieval bank read","component":"rag:demo","hits":29,
// "misses":1,"baselineHits":29,"baselineMisses":1,...}` — both legs summed, because
// a baseline miss retrieves exactly as a live one does. The pre-O2 free-text line
// (`[rag:demo] retrieval bank 843fcf6f: 29 hit · 1 miss · depth 10 · baseline …`)
// is still read so an old dev log parses.
const BANK_LINE = /\[rag:demo\] retrieval bank \S+: (\d+) hit · (\d+) miss · depth \d+(?: · baseline (\d+) hit · (\d+) miss)?/;
function bankOf(lines: string[]): { hits: number; misses: number } | null {
  let seen = false;
  let hits = 0;
  let misses = 0;
  for (const l of lines) {
    const m = BANK_LINE.exec(l);
    if (m) {
      seen = true;
      hits += Number(m[1]) + Number(m[3] ?? 0);
      misses += Number(m[2]) + Number(m[4] ?? 0);
      continue;
    }
    if (!l.includes('"retrieval bank read"')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(l.slice(l.indexOf("{"))) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.msg !== "retrieval bank read") continue;
    seen = true;
    hits += Number(j.hits ?? 0) + Number(j.baselineHits ?? 0);
    misses += Number(j.misses ?? 0) + Number(j.baselineMisses ?? 0);
  }
  return seen ? { hits, misses } : null;
}

function outcomesOf(events: Record<string, unknown>[], name: Map<string, string>): Outcome[] {
  const out: Outcome[] = [];
  for (const e of events) {
    if (e.type === "chunk-published" || e.type === "chunk-unresolved") {
      const id = String(e.chunkId);
      out.push({
        key: name.get(id) ?? id,
        chunkId: id,
        status: e.type === "chunk-published" ? "published" : "unresolved",
        detail: String(e.detail ?? e.reason ?? ""),
        pieces: typeof e.pieces === "number" ? e.pieces : null,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const chunkIdsIn = (events: Record<string, unknown>[]): string[] =>
  [...new Set(events.filter((e) => typeof e.chunkId === "string").map((e) => String(e.chunkId)))];

// Read through DATABASE_URL (the postgres role — no RLS to satisfy). One
// connection, opened for the read-back and closed after it.
async function withDb<T>(configId: string, fn: (raw: postgres.Sql, table: string) => Promise<T>): Promise<T> {
  const raw = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    ssl: sslFor(process.env.DATABASE_URL!),
    max: 1,
  });
  try {
    const [cfg] = await raw<{ base_model: string }[]>`
      select base_model from configs where id = ${configId}
    `;
    if (!cfg) throw new Error(`no config ${configId} — the guest may have been reaped`);
    return await fn(raw, chunksTable(cfg.base_model, modelSpec(cfg.base_model).dimension));
  } finally {
    await raw.end();
  }
}

// chunk id → "<file>#<position>", the name that survives a re-clone.
async function nameChunks(raw: postgres.Sql, table: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const named = await raw<{ id: string; file_name: string; position: number }[]>`
    select c.id, doc.file_name, c.position
    from ${raw(table)} c
    join documents doc on doc.id = c.document_id
    where c.id = any(${ids}::uuid[])
  `;
  return new Map(named.map((n) => [n.id, `${n.file_name}#${n.position}`]));
}

// The guest's latest non-baseline result per label, with every id translated
// to "<file>#<position>" so two guests' lists can be compared position for
// position.
async function ranksOf(raw: postgres.Sql, table: string, configId: string): Promise<Rank[]> {
  {
    const rows = await raw<
      {
        question: string;
        file_name: string;
        position: number;
        retrieved_ids: string[];
        hit: boolean;
        found_rank: number | null;
      }[]
    >`
      select distinct on (l.id)
             q.question, doc.file_name, c.position,
             r.retrieved_ids, r.hit, r.found_rank
      from eval_questions q
      join eval_labels l on l.eval_question_id = q.id
      join document_embeddings de on de.id = l.document_embedding_id
      join ${raw(table)} c on c.id = l.source_chunk_id
      join documents doc on doc.id = c.document_id
      join eval_results r on r.eval_label_id = l.id and not r.is_baseline
      where de.config_id = ${configId}
      order by l.id, r.scored_at desc
    `;
    const name = await nameChunks(raw, table, [...new Set(rows.flatMap((r) => r.retrieved_ids))]);
    return rows
      .map((r) => ({
        key: `${r.file_name}#${r.position}::${r.question}`,
        retrieved: r.retrieved_ids.map((id) => name.get(id) ?? id),
        hit: r.hit,
        foundRank: r.found_rank,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}

// Outcomes and ranks together: what `run` records, and what `rekey` recomputes
// for a saved run from its press.ndjson (the guest has to still exist).
async function readBack(configId: string, press: Record<string, unknown>[]): Promise<{ outcomes: Outcome[]; ranks: Rank[] }> {
  return withDb(configId, async (raw, table) => ({
    outcomes: outcomesOf(press, await nameChunks(raw, table, chunkIdsIn(press))),
    ranks: await ranksOf(raw, table, configId),
  }));
}

// ---------------------------------------------------------------------------
// Egress: the meter, with its state file kept inside the run's directory so a
// bench never clobbers data/egress-meter.json.
// ---------------------------------------------------------------------------

function egress(cmd: "start" | "report", label: string, dir: string): string {
  const r = spawnSync("npm", ["run", "--silent", "egress", "--", cmd, label], {
    encoding: "utf8",
    env: { ...process.env, EGRESS_STATE: join(dir, "egress-state.json") },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) console.warn(`egress ${cmd} exited ${r.status}:\n${out}`);
  return out;
}

const egressMb = (report: string): number | null => {
  const m = /TOTAL estimated egress\s+([\d.]+)\s*MB/i.exec(report);
  return m ? +m[1] : null;
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

// One walk = one guest, `--presses N` laps on it (default 1). A boarded guest's
// "Add cached" hands out ONE banked question per chunk per press, easy first,
// so lap 2 is the plan's "+ medium → ⚙": the same 30 chunks, 30 more
// questions, and a press that starts with lap 1's overrides in play (§0's run
// 2, 373 s). Each lap is recorded as its own run — `<label>` for the first,
// `<label>-p2` for the second — so compare and gate work on a lap unchanged.
async function run(label: string): Promise<void> {
  const base = arg("--base", DEFAULT_BASE);
  const log = arg("--log", DEFAULT_LOG);
  const presses = Number(arg("--presses", "1"));
  for (let i = 1; i <= presses; i++) {
    const dir = join(ROOT, i === 1 ? label : `${label}-p${i}`);
    if (existsSync(join(dir, "summary.json")) && !process.argv.includes("--force")) {
      throw new Error(`${dir} already has a run — pick another label or pass --force`);
    }
  }
  if (!existsSync(log)) {
    throw new Error(`no dev log at ${log} — start the server with:\n` +
      `  AUTOTUNE_TIMING=1 npm run dev > ${DEFAULT_LOG} 2>&1 &`);
  }
  const head = git("rev-parse --short HEAD");
  const dirty = git("status --porcelain") !== "";
  console.log(`bench "${label}" at ${head}${dirty ? " (dirty)" : ""}, ${presses} press(es)`);

  const guest = await mintGuest(base);
  console.log(`  guest ${guest.configId}`);
  for (let i = 1; i <= presses; i++) {
    await lap(i === 1 ? label : `${label}-p${i}`, i, guest, base, log, head, dirty);
  }
}

async function lap(
  label: string,
  lapNo: number,
  guest: Guest,
  base: string,
  log: string,
  head: string,
  dirty: boolean,
): Promise<void> {
  const dir = join(ROOT, label);
  mkdirSync(dir, { recursive: true });
  const logOffset = statSync(log).size;
  console.log(`  lap ${lapNo} → ${dir}`);

  egress("start", label, dir);

  const add = await stream(base, guest, "/api/eval/bulk-generate", { cachedOnly: true }, join(dir, "add.ndjson"));
  console.log(`  add cached: ${(add.ms / 1000).toFixed(1)} s, ${add.events.length} events`);

  const scoreOffset = statSync(log).size;
  const score = await stream(base, guest, "/api/eval/process", {}, join(dir, "score.ndjson"));
  const scoreDone = score.events.find((e) => e.type === "done") ?? null;
  console.log(`  score pending: ${(score.ms / 1000).toFixed(1)} s, ${JSON.stringify(scoreDone)?.slice(0, 160)}`);

  const pressOffset = statSync(log).size;
  const press = await stream(base, guest, "/api/eval/autotune", {}, join(dir, "press.ndjson"));
  const done = press.events.find((e) => e.type === "autotune-done") ?? null;
  console.log(`  press: ${(press.ms / 1000).toFixed(1)} s, ${JSON.stringify(done)?.slice(0, 240)}`);

  const report = egress("report", label, dir);
  writeFileSync(join(dir, "egress.txt"), report);

  // Everything the server printed during the walk, and the timing lines alone.
  const delta = readFileSync(log, "utf8").slice(logOffset);
  const timingLines = delta.split("\n").filter((l) => l.includes("[rag:autotune:timing]") || ROW.test(l));
  writeFileSync(join(dir, "timing.log"), timingLines.join("\n") + "\n");
  const timing = parseTiming(delta.split("\n"));
  const pressLog = delta.slice(delta.indexOf("rtt n="));
  const otherRequests = pressLog
    .split("\n")
    .filter((l) => /^\s*(GET|POST|PUT|DELETE) \//.test(l) && !l.includes("/api/eval/autotune")).length;
  if (otherRequests) {
    console.warn(`  ${otherRequests} other request(s) hit the server during the press (a tab polling?) — their statements landed in the table`);
  }
  if (timing.wall === null) {
    throw new Error(
      `no [rag:autotune:timing] TABLE in ${log} during the press — the server is not ` +
        `running with AUTOTUNE_TIMING=1, or its stdout is not this file. The streams are ` +
        `saved in ${dir} but no summary was written.`,
    );
  }

  const scoreBank = bankOf(readFileSync(log, "utf8").slice(scoreOffset, pressOffset).split("\n"));
  const pressBank = bankOf(readFileSync(log, "utf8").slice(pressOffset).split("\n"));
  const bank =
    scoreBank || pressBank
      ? {
          scoreHits: scoreBank?.hits ?? 0,
          scoreMisses: scoreBank?.misses ?? 0,
          pressHits: pressBank?.hits ?? 0,
          pressMisses: pressBank?.misses ?? 0,
        }
      : null;
  if (bank) console.log(`  retrieval bank: score ${bank.scoreHits} hit / ${bank.scoreMisses} miss · press ${bank.pressHits} hit / ${bank.pressMisses} miss`);

  const summary: Summary = {
    label,
    press: lapNo,
    at: new Date().toISOString(),
    head,
    dirty,
    base,
    configId: guest.configId,
    rtt: timing.rtt,
    addMs: Math.round(add.ms),
    scoreMs: Math.round(score.ms),
    scoreDone,
    pressMs: Math.round(press.ms),
    pressWallS: timing.wall,
    stagedS: timing.staged,
    statements: timing.statements,
    otherRequests,
    stages: timing.stages,
    done,
    ...(await readBack(guest.configId, press.events)),
    egressMb: egressMb(report),
    bank,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  appendRow(summary);
  printSummary(summary);
}

function appendRow(s: Summary): void {
  const file = join(ROOT, "runs.md");
  const header =
    "| label | at | head | press wall | stmts | rtt med | score pending | kept / unresolved | recall | mrr | egress MB | bank hit / miss |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
  const kept = s.outcomes.filter((o) => o.status === "published").length;
  const unres = s.outcomes.length - kept;
  const d = s.done ?? {};
  const row =
    `| ${s.label} | ${s.at.slice(0, 16)} | ${s.head}${s.dirty ? "*" : ""} | ${s.pressWallS} s | ${s.statements} | ` +
    `${s.rtt?.median ?? "?"} ms | ${(s.scoreMs / 1000).toFixed(1)} s | ${kept} / ${unres} | ` +
    `${fmt(d.recall)} | ${fmt(d.mrr)} | ${s.egressMb ?? "?"} | ` +
    `${s.bank ? `${s.bank.scoreHits + s.bank.pressHits} / ${s.bank.scoreMisses + s.bank.pressMisses}` : "—"} |\n`;
  writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : header) + row);
}

const fmt = (v: unknown) => (typeof v === "number" ? v.toFixed(3) : "?");

function printSummary(s: Summary): void {
  console.log(
    `\n${s.label}: press ${s.pressWallS} s (staged ${s.stagedS} s), ${s.statements} statements, ` +
      `rtt median ${s.rtt?.median ?? "?"} ms, egress ${s.egressMb ?? "?"} MB` +
      (s.bank ? `, bank ${s.bank.scoreHits + s.bank.pressHits} hit / ${s.bank.scoreMisses + s.bank.pressMisses} miss` : ""),
  );
  const w = Math.max(...s.stages.map((r) => r.stage.length), 5);
  for (const r of s.stages.slice(0, 12)) {
    console.log(
      `  ${r.stage.padEnd(w)}  ${r.s.toFixed(1).padStart(6)} s  ${String(r.stmts).padStart(5)} stmts  ` +
        `${String(r.calls).padStart(3)} calls  ${String(r.msPerCall).padStart(5)} ms/call  ${r.share.toFixed(1).padStart(5)}%`,
    );
  }
  if (s.stages.length > 12) console.log(`  … ${s.stages.length - 12} more rows in summary.json`);
}

// ---------------------------------------------------------------------------
// compare — the gate
// ---------------------------------------------------------------------------

function load(label: string): Summary {
  const f = join(ROOT, label, "summary.json");
  if (!existsSync(f)) throw new Error(`no run "${label}" (${f})`);
  return JSON.parse(readFileSync(f, "utf8")) as Summary;
}

function compare(a: Summary, b: Summary): boolean {
  console.log(`\n${a.label} (${a.head}) → ${b.label} (${b.head})\n`);
  const line = (k: string, x: unknown, y: unknown, unit = "") =>
    console.log(`  ${k.padEnd(18)} ${String(x).padStart(10)}${unit} → ${String(y).padStart(10)}${unit}`);
  line("press wall", a.pressWallS, b.pressWallS, " s");
  line("statements", a.statements, b.statements);
  line("other requests", a.otherRequests ?? "?", b.otherRequests ?? "?");
  line("rtt median", a.rtt?.median, b.rtt?.median, " ms");
  line("score pending", (a.scoreMs / 1000).toFixed(1), (b.scoreMs / 1000).toFixed(1), " s");
  line("egress", a.egressMb ?? "?", b.egressMb ?? "?", " MB");

  // Stage table: every stage either side has, ordered by the size of the change.
  const names = new Set([...a.stages, ...b.stages].map((r) => r.stage));
  const rows = [...names]
    .map((n) => {
      const x = a.stages.find((r) => r.stage === n);
      const y = b.stages.find((r) => r.stage === n);
      return { n, xs: x?.s ?? 0, ys: y?.s ?? 0, xq: x?.stmts ?? 0, yq: y?.stmts ?? 0 };
    })
    .sort((p, q) => Math.abs(q.ys - q.xs) - Math.abs(p.ys - p.xs));
  const w = Math.max(...rows.map((r) => r.n.length), 5);
  console.log(`\n  ${"stage".padEnd(w)}  ${"before".padStart(8)}  ${"after".padStart(8)}  ${"Δ s".padStart(8)}  ${"stmts".padStart(12)}`);
  for (const r of rows) {
    if (r.xs < 0.05 && r.ys < 0.05) continue;
    console.log(
      `  ${r.n.padEnd(w)}  ${r.xs.toFixed(1).padStart(8)}  ${r.ys.toFixed(1).padStart(8)}  ` +
        `${(r.ys - r.xs).toFixed(1).padStart(8)}  ${`${r.xq} → ${r.yq}`.padStart(12)}`,
    );
  }

  // Outcomes: same chunks, same decisions.
  let ok = true;
  const oa = new Map(a.outcomes.map((o) => [o.key, o]));
  const ob = new Map(b.outcomes.map((o) => [o.key, o]));
  const oDiffs: string[] = [];
  for (const k of new Set([...oa.keys(), ...ob.keys()])) {
    const x = oa.get(k);
    const y = ob.get(k);
    if (!x || !y) oDiffs.push(`${k}: ${x ? "only before" : "only after"}`);
    else if (x.status !== y.status || x.detail !== y.detail || x.pieces !== y.pieces)
      oDiffs.push(`${k}: ${x.status} "${x.detail}" → ${y.status} "${y.detail}"`);
  }
  console.log(`\n  outcomes: ${a.outcomes.length} vs ${b.outcomes.length} chunks, ${oDiffs.length} differ`);
  for (const d of oDiffs) console.log(`    ${d}`);
  if (oDiffs.length) ok = false;

  // Ranks: position for position, every question.
  const ra = new Map(a.ranks.map((r) => [r.key, r]));
  const rb = new Map(b.ranks.map((r) => [r.key, r]));
  let same = 0;
  const rDiffs: string[] = [];
  for (const k of new Set([...ra.keys(), ...rb.keys()])) {
    const x = ra.get(k);
    const y = rb.get(k);
    if (!x || !y) {
      rDiffs.push(`${k.slice(0, 70)}: ${x ? "only before" : "only after"}`);
      continue;
    }
    const at = firstDiff(x.retrieved, y.retrieved);
    if (at === -1) same += 1;
    else rDiffs.push(`${k.slice(0, 70)}: differs at rank ${at + 1} (${x.retrieved[at] ?? "∅"} → ${y.retrieved[at] ?? "∅"})`);
  }
  console.log(`  ranks: ${same}/${Math.max(ra.size, rb.size)} questions identical position for position`);
  for (const d of rDiffs) console.log(`    ${d}`);
  if (rDiffs.length) ok = false;

  if (a.egressMb !== null && b.egressMb !== null && b.egressMb > a.egressMb * 1.05) {
    console.log(`  egress ROSE: ${a.egressMb} → ${b.egressMb} MB`);
    ok = false;
  }
  const pct = a.pressWallS && b.pressWallS ? 100 * (1 - b.pressWallS / a.pressWallS) : null;
  console.log(
    `\n  ${ok ? "GATE HELD" : "GATE FAILED"}: ${a.pressWallS} s → ${b.pressWallS} s` +
      (pct === null ? "" : pct >= 0 ? ` (${pct.toFixed(1)}% faster)` : ` (${(-pct).toFixed(1)}% slower)`),
  );
  return ok;
}

// Recompute a saved run's outcomes and ranks from its press.ndjson and the
// database. For runs recorded before a read-back fix; the guest must still
// exist (they are reaped two hours after minting).
async function rekey(label: string): Promise<void> {
  const s = load(label);
  const press = readFileSync(join(ROOT, label, "press.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  Object.assign(s, await readBack(s.configId, press));
  writeFileSync(join(ROOT, label, "summary.json"), JSON.stringify(s, null, 2) + "\n");
  console.log(`${label}: ${s.outcomes.length} outcomes, ${s.ranks.length} ranks re-read`);
}

// THE GATE WITH A NOISE MODEL. Two guests on the same code do not always agree
// on every rank list: the HNSW index is built per clone, so a near-tie can
// order differently at rank 5 (baseline-1 vs baseline-3: 29/30, one flip at
// rank 1 on a question whose answer sits at a tie). `compare` reports every
// difference; `gate` decides. A cut passes when:
//   - every chunk outcome matches every baseline (deterministic, no allowance);
//   - the finale's recall and MRR match every baseline;
//   - it has no more NOVEL rank lists (a list none of the baselines produced)
//     than the noisiest baseline has against its siblings;
//   - egress is not up more than 5% on any baseline.
function gate(cut: Summary, baselines: Summary[]): boolean {
  if (baselines.length < 2) throw new Error("gate needs at least two baselines");
  let ok = true;
  console.log(`\ngate ${cut.label} (${cut.head}) against ${baselines.map((b) => b.label).join(", ")}\n`);

  for (const b of baselines) {
    const oa = new Map(b.outcomes.map((o) => [o.key, o]));
    const diffs = cut.outcomes.filter((o) => {
      const x = oa.get(o.key);
      return !x || x.status !== o.status || x.detail !== o.detail || x.pieces !== o.pieces;
    }).length + b.outcomes.filter((o) => !cut.outcomes.some((c) => c.key === o.key)).length;
    const dc = cut.done ?? {};
    const db = b.done ?? {};
    const metrics = fmt(dc.recall) === fmt(db.recall) && fmt(dc.mrr) === fmt(db.mrr);
    console.log(`  vs ${b.label.padEnd(14)} outcomes ${diffs === 0 ? "identical" : `${diffs} DIFFER`}, ` +
      `recall/mrr ${metrics ? "identical" : `DIFFER (${fmt(db.recall)}/${fmt(db.mrr)} → ${fmt(dc.recall)}/${fmt(dc.mrr)})`}, ` +
      `egress ${b.egressMb} → ${cut.egressMb} MB`);
    if (diffs > 0 || !metrics) ok = false;
    if (b.egressMb !== null && cut.egressMb !== null && cut.egressMb > b.egressMb * 1.05) ok = false;
  }

  // Novel lists: for each question, the set of lists the baselines produced.
  const seen = new Map<string, Set<string>>();
  for (const b of baselines) {
    for (const r of b.ranks) {
      const set = seen.get(r.key) ?? new Set<string>();
      set.add(r.retrieved.join("|"));
      seen.set(r.key, set);
    }
  }
  const novelOf = (s: Summary, others: Summary[]): string[] => {
    const lists = new Map<string, Set<string>>();
    for (const o of others) for (const r of o.ranks) {
      const set = lists.get(r.key) ?? new Set<string>();
      set.add(r.retrieved.join("|"));
      lists.set(r.key, set);
    }
    return s.ranks.filter((r) => !(lists.get(r.key)?.has(r.retrieved.join("|")) ?? false)).map((r) => r.key);
  };
  const budget = Math.max(...baselines.map((b) => novelOf(b, baselines.filter((o) => o !== b)).length));
  const novel = novelOf(cut, baselines);
  console.log(`\n  novel rank lists: ${novel.length} (noise budget from the baselines: ${budget})`);
  for (const k of novel) console.log(`    ${k.slice(0, 90)}`);
  if (novel.length > budget) ok = false;

  const walls = baselines.map((b) => b.pressWallS ?? 0);
  const mean = walls.reduce((a, b) => a + b, 0) / walls.length;
  const stmts = baselines.map((b) => b.statements ?? 0);
  const smean = stmts.reduce((a, b) => a + b, 0) / stmts.length;
  console.log(
    `\n  press wall ${mean.toFixed(1)} s (baselines ${Math.min(...walls)}–${Math.max(...walls)}) → ${cut.pressWallS} s` +
      ` (${(100 * (1 - (cut.pressWallS ?? 0) / mean)).toFixed(1)}% faster than the mean)\n` +
      `  statements ${smean.toFixed(0)} (${Math.min(...stmts)}–${Math.max(...stmts)}) → ${cut.statements}` +
      ` (${(100 * (1 - (cut.statements ?? 0) / smean)).toFixed(1)}% fewer)`,
  );
  // The bank's floor (docs/demo-retrieval-bank-plan.md §5): a run on a banked
  // seed must record ZERO misses on the default walk — every state it reaches is
  // one the publish walked. A run with no bank lines is a run before the bank
  // and is not held to it.
  if (cut.bank) {
    const misses = cut.bank.scoreMisses + cut.bank.pressMisses;
    console.log(`\n  retrieval bank: ${cut.bank.scoreHits + cut.bank.pressHits} hit, ${misses} miss${misses === 0 ? "" : " — the walk did not cover this state"}`);
    if (misses > 0) ok = false;
  }

  console.log(`\n  ${ok ? "GATE HELD" : "GATE FAILED"}`);
  return ok;
}

function firstDiff(x: string[], y: string[]): number {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
  return x.length === y.length ? -1 : n;
}

function list(): void {
  if (!existsSync(ROOT)) return console.log("no runs");
  for (const d of readdirSync(ROOT)) {
    const f = join(ROOT, d, "summary.json");
    if (!existsSync(f)) continue;
    const s = JSON.parse(readFileSync(f, "utf8")) as Summary;
    console.log(`${s.label.padEnd(24)} ${s.at.slice(0, 16)}  ${s.head}${s.dirty ? "*" : " "}  ${String(s.pressWallS).padStart(6)} s  ${String(s.statements).padStart(5)} stmts`);
  }
}

async function main(): Promise<void> {
  // Positionals are what is left once every `--flag value` pair (and the bare
  // `--force`) is taken out.
  const args = process.argv.slice(2);
  const positionalAll: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force") continue;
    if (args[i].startsWith("--")) {
      i += 1;
      continue;
    }
    positionalAll.push(args[i]);
  }
  const [cmd, ...positional] = positionalAll;
  if (cmd === "run") {
    if (!positional[0]) throw new Error("run needs a label");
    await run(positional[0]);
  } else if (cmd === "compare") {
    if (positional.length < 2) throw new Error("compare needs two labels");
    const ok = compare(load(positional[0]), load(positional[1]));
    process.exitCode = ok ? 0 : 1;
  } else if (cmd === "gate") {
    if (positional.length < 3) throw new Error("gate needs a cut and at least two baselines");
    const ok = gate(load(positional[0]), positional.slice(1).map(load));
    process.exitCode = ok ? 0 : 1;
  } else if (cmd === "rekey") {
    if (!positional[0]) throw new Error("rekey needs a label");
    await rekey(positional[0]);
  } else if (cmd === "list") {
    list();
  } else {
    console.log("usage: autotune:bench -- run <label> [--log f] [--base url] [--force] | compare <a> <b> | gate <cut> <b1> <b2>… | rekey <label> | list");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
