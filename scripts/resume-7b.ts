// Drive the Phase 7b autotune sweep, one scoped group of chunks at a time.
//
//   npm run resume:7b -- plan            print the groups without running anything
//   npm run resume:7b -- group <n>       run one group and stop
//   npm run resume:7b -- all             run every group not yet recorded as done
//   npm run resume:7b -- watch <n> <job> re-attach to a group whose driver died
//   npm run resume:7b -- status          what has run so far
//
// WHY NOT jobs-smoke. That harness's `autotune` verb is an assertion rig: it runs
// whatever the config's whole labeled set is and then checks smoke-test properties.
// 7b needs the opposite — a frozen, pre-scoped target list swept in order, with the
// coverage of each group recorded for the writeup. The launch/tick/watch mechanics
// below are modelled on it, and the tick endpoint is still the reason this works
// without a browser: it is the one job route with no session (signed instead), so a
// sliced run is drivable from the command line.
//
// THE TARGET SET IS FROZEN ON PURPOSE. docs/resume-metrics-7b-targets.json was
// captured at one retrieval fingerprint before the holdout was folded in. Autotune
// recomputes targets from current scores every run, so a chunk in the list may have
// nothing left to target by the time its group runs — that is a resolved chunk, not
// an error. What must NOT happen is the sweep growing: fixing a chunk displaces
// others (the confirm veto is chunk-local), so re-deriving the list mid-sweep would
// chase a tail that regenerates. One pass over the frozen list is the experiment.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";

import { signJobTick } from "../lib/http/jobSecret";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: sslFor(process.env.DATABASE_URL!), max: 2 });
const BASE = process.env.JOBS_BASE_URL ?? "http://localhost:3002";
const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

const TARGETS = "docs/resume-metrics-7b-targets.json";
const PROGRESS = "docs/resume-metrics-7b-progress.json";
const GROUP_SIZE = Number(process.env.RESUME_7B_GROUP_SIZE ?? 5);

type Target = {
  source_chunk_id: string;
  failing: number;
  failing_holdout: number;
  misses: number;
  previously_attempted: boolean;
};

type GroupResult = {
  group: number;
  chunkIds: string[];
  jobId: string;
  status: string;
  slices: number;
  runId: string | null;
  chunksTotal: number | null;
  chunksSearched: number | null;
  chunksFailed: number | null;
  targeted: number | null;
  resolved: number | null;
  improved: number | null;
  stopReason: string | null;
  tailStatus: string | null;
  error: string | null;
  startedAt: string;
  minutes: number;
};

// Never-attempted chunks lead: they are where the ladder has not already failed
// once, so if the sweep is cut short the time spent bought the most overrides.
// Within each half, more failing questions first — those move the aggregate most.
function groups(): string[][] {
  const targets: Target[] = JSON.parse(readFileSync(TARGETS, "utf8"));
  const ordered = [...targets].sort((a, b) => {
    if (a.previously_attempted !== b.previously_attempted) return a.previously_attempted ? 1 : -1;
    if (b.failing !== a.failing) return b.failing - a.failing;
    return a.source_chunk_id.localeCompare(b.source_chunk_id);
  });
  const out: string[][] = [];
  for (let i = 0; i < ordered.length; i += GROUP_SIZE) {
    out.push(ordered.slice(i, i + GROUP_SIZE).map((t) => t.source_chunk_id));
  }
  return out;
}

function progress(): GroupResult[] {
  return existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : [];
}

function record(result: GroupResult): void {
  const all = progress().filter((r) => r.group !== result.group);
  all.push(result);
  all.sort((a, b) => a.group - b.group);
  writeFileSync(PROGRESS, `${JSON.stringify(all, null, 1)}\n`);
}

async function owner(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select p.id from user_profiles p
    join configs c on c.user_id = p.id where c.id = ${CONFIG_ID} limit 1`;
  if (rows.length === 0) throw new Error(`No owner for config ${CONFIG_ID}.`);
  return rows[0].id;
}

async function tick(jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/jobs/tick`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-job-signature": signJobTick(jobId) },
    body: JSON.stringify({ jobId }),
  });
  if (!res.ok) console.log(`  tick -> ${res.status} ${await res.text()}`);
}

// Poll until terminal, stepping in only when a slice died without chaining — the
// same janitor role jobs-smoke's driveToEnd plays. Slices are minutes long, so a
// 5s poll is plenty and keeps the log readable over a multi-hour sweep.
async function driveToEnd(jobId: string, label: string) {
  let lastPhase = "";
  for (;;) {
    const [job] = await sql<
      {
        status: string;
        attempts: number;
        phase: string | null;
        run_id: string | null;
        lease_expires_at: Date | null;
        error: string | null;
      }[]
    >`
      select status, attempts, cursor->>'phase' as phase, cursor->>'runId' as run_id,
             lease_expires_at, error
        from background_jobs where id = ${jobId}`;
    if (!job) throw new Error("No such job.");
    if (job.phase && job.phase !== lastPhase) {
      lastPhase = job.phase;
      console.log(`  ${label} phase: ${job.phase} (slice ${job.attempts})`);
    }
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (!job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now()) await tick(jobId);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// The runner chains slices in the SERVER process, so killing this driver leaves the
// job running. That makes a double-launch the real hazard here: POST /api/jobs
// refuses a second job of a kind per config, but this script writes the ledger row
// itself and never passes through that check, so it has to make the same one.
async function assertNoActiveJob(): Promise<void> {
  const active = await sql<{ id: string; phase: string | null }[]>`
    select id, cursor->>'phase' as phase from background_jobs
     where config_id = ${CONFIG_ID} and kind = 'autotune'
       and status in ('queued', 'running')`;
  if (active.length > 0) {
    throw new Error(
      `autotune job ${active[0].id} is still ${active[0].phase ?? "active"} on this config — ` +
        `watch it with: npm run resume:7b -- watch <group> ${active[0].id}`,
    );
  }
}

async function runGroup(index: number, chunkIds: string[], userId: string): Promise<GroupResult> {
  const label = `group ${index}`;
  const startedAt = new Date();
  await assertNoActiveJob();
  console.log(`\n${label}: ${chunkIds.length} chunk(s)`);

  // Scope first, and read it back. A silently-unset scope is the one failure that
  // costs a full-corpus search instead of a five-chunk one, and it would look like
  // a slow but healthy run in the log.
  await sql`
    update configs set autotune_chunk_scope = ${chunkIds}::uuid[]
     where id = ${CONFIG_ID}`;
  const [check] = await sql<{ n: number }[]>`
    select coalesce(array_length(autotune_chunk_scope, 1), 0)::int as n
      from configs where id = ${CONFIG_ID}`;
  if (check.n !== chunkIds.length) {
    throw new Error(`scope readback is ${check.n}, expected ${chunkIds.length} — refusing to run`);
  }

  const [job] = await sql<{ id: string }[]>`
    insert into background_jobs
      (user_id, kind, config_id, config_label, scope, total_units, status)
    values (${userId}, 'autotune', ${CONFIG_ID}, ${`7b ${label}`}, ${sql.json({})},
            ${chunkIds.length}, 'queued')
    returning id`;
  console.log(`  job ${job.id}`);
  await tick(job.id);
  return collect(index, chunkIds, job.id, startedAt);
}

// Read the outcome off the run the CURSOR carried. Not "the newest autotune_runs
// row": that row is only written at the `outcomes` phase near the end, so anything
// sampled earlier returns a PREVIOUS run's numbers and looks perfectly plausible.
async function collect(
  index: number,
  chunkIds: string[],
  jobId: string,
  startedAt: Date,
): Promise<GroupResult> {
  const label = `group ${index}`;
  const done = await driveToEnd(jobId, label);

  const [row] = done.run_id
    ? await sql<
        {
          chunks_total: number | null;
          chunks_searched: number | null;
          chunks_failed: number | null;
          targeted: number | null;
          resolved: number | null;
          improved: number | null;
          stop_reason: string | null;
          tail_status: string | null;
        }[]
      >`
        select chunks_total, chunks_searched, chunks_failed,
               targeted, resolved, improved, stop_reason, tail_status
          from autotune_runs where id = ${done.run_id}`
    : [];

  const result: GroupResult = {
    group: index,
    chunkIds,
    jobId,
    status: done.status,
    slices: done.attempts,
    runId: done.run_id,
    chunksTotal: row?.chunks_total ?? null,
    chunksSearched: row?.chunks_searched ?? null,
    chunksFailed: row?.chunks_failed ?? null,
    targeted: row?.targeted ?? null,
    resolved: row?.resolved ?? null,
    improved: row?.improved ?? null,
    stopReason: row?.stop_reason ?? null,
    tailStatus: row?.tail_status ?? null,
    error: done.error,
    startedAt: startedAt.toISOString(),
    minutes: Number(((Date.now() - startedAt.getTime()) / 60_000).toFixed(1)),
  };
  record(result);
  console.log(
    `  ${result.status} in ${result.minutes} min, ${result.slices} slice(s) — ` +
      `searched ${result.chunksSearched ?? "?"}/${result.chunksTotal ?? "?"}, ` +
      `targeted ${result.targeted ?? "?"}, resolved ${result.resolved ?? "?"}, ` +
      `improved ${result.improved ?? "?"}` +
      (result.error ? `\n  error: ${result.error}` : ""),
  );
  return result;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const all = groups();

  if (!command || command === "plan") {
    const targets: Target[] = JSON.parse(readFileSync(TARGETS, "utf8"));
    const done = new Set(progress().map((r) => r.group));
    console.log(`${targets.length} chunks in ${all.length} group(s) of ${GROUP_SIZE}`);
    all.forEach((g, i) => console.log(`  group ${i}: ${g.length} chunk(s)${done.has(i) ? " — done" : ""}`));
    return;
  }

  if (command === "status") {
    for (const r of progress()) {
      console.log(
        `group ${r.group}: ${r.status} in ${r.minutes} min — searched ` +
          `${r.chunksSearched ?? "?"}/${r.chunksTotal ?? "?"}, resolved ${r.resolved ?? "?"}`,
      );
    }
    return;
  }

  const userId = await owner();

  // Re-attach to a job this driver launched and then lost. Killing the driver does
  // not kill the job — the runner chains its slices server-side — so the group is
  // still progressing and only its journal entry is missing.
  if (command === "watch") {
    const n = Number(arg);
    const jobId = process.argv[4];
    if (!Number.isInteger(n) || n < 0 || n >= all.length) throw new Error(`group must be 0..${all.length - 1}`);
    if (!jobId) throw new Error("usage: watch <group> <jobId>");
    const [job] = await sql<{ started_at: Date }[]>`
      select started_at from background_jobs where id = ${jobId}`;
    if (!job) throw new Error(`no such job ${jobId}`);
    await collect(n, all[n], jobId, job.started_at);
    return;
  }

  if (command === "group") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 0 || n >= all.length) throw new Error(`group must be 0..${all.length - 1}`);
    await runGroup(n, all[n], userId);
    return;
  }

  if (command === "all") {
    const done = new Set(progress().filter((r) => r.status === "succeeded").map((r) => r.group));
    for (let i = 0; i < all.length; i += 1) {
      if (done.has(i)) continue;
      const r = await runGroup(i, all[i], userId);
      // A failed group is usually the Postgres lock pool and is retryable, but
      // stopping is right: an unattended sweep that keeps going past a systematic
      // failure burns hours producing nothing.
      if (r.status !== "succeeded") {
        console.log(`\nstopping at group ${i} (${r.status}). Re-run to retry it.`);
        break;
      }
    }
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
