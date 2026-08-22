// Drive a background job end to end from the command line, without a browser.
//
// The tick endpoint has no session by design, so everything the runner does can be
// exercised from here: launch, slice, chain, checkpoint, resume, cancel. Only the
// UI is out of scope.
//
//   npm run jobs:smoke -- launch [documentId]   create a re-score job and tick it
//   npm run jobs:smoke -- watch <jobId>         poll the row until it finishes
//   npm run jobs:smoke -- cancel <jobId>
//   npm run jobs:smoke -- sweep                 janitor: revive every stalled job
//   npm run jobs:smoke -- background [docId]    prove the background path and ASSERT
//   npm run jobs:smoke -- autotune              run a sliced autotune and ASSERT
//   npm run jobs:smoke -- abandon               manufacture a stale corpus (§D.1)
//   npm run jobs:smoke                          list the ten newest jobs
//
// The verbs that SPEND — launch, background, autotune, abandon — refuse to run
// without SMOKE_ALLOW_WRITES=1. `watch`, `cancel`, `sweep` and the bare listing
// stay open: those are what you reach for when a run has gone wrong.
//
// WHAT THE `autotune` VERB CAN AND CANNOT SEE. It drives the BACKGROUND driver,
// because the tick endpoint is the only one here that works without a session —
// /api/eval/autotune is a user route and this harness has no cookie. Both drivers
// run the same step, so every phase-level property is covered from here: multi-slice
// search over a frozen plan, coverage that adds up, an idempotent history row, the
// dirty set after a crashed slice, and `settle` after an abandonment. What is NOT
// covered is the streamed driver's own behavior — the per-slice commit and the
// yield deadline of docs/autotune-slicing-fixes-plan.md §D/§D.2 — which lives in
// lib/jobs/stream.ts and needs a browser session to reach. The pure half of that
// (the drain guard a yield must not trip) is in autotuneSlice.test.ts.
//
// SQL AND HTTP ONLY, no app imports beyond the signature helper. The store and the
// runner pull in lib/rag/eval, which is "server-only" and throws the moment tsx
// loads it outside Next — so this harness writes the ledger row itself and then
// hands the work to the running server, which is also the more honest test: the
// slice really does run in the server process, over the same HTTP hop a chained
// slice uses in production.
//
// Needs the dev server up. Set JOBS_SLICE_BUDGET_MS small (e.g. 20000) in the
// SERVER's environment to force several slices out of a short job.
import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";

import { signJobTick } from "../lib/http/jobSecret";

const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  ssl: sslFor(process.env.DATABASE_URL!),
  max: 2,
});
const BASE = process.env.JOBS_BASE_URL ?? "http://localhost:3002";

// The owner is DERIVED FROM THE CONFIG when one is named, not chosen separately.
// Picking them independently produces a job whose config belongs to someone else,
// which the runner correctly refuses ("the config this job was running on no
// longer exists" — resolveConfig is user-scoped) after the row is already created.
async function owner(): Promise<{ id: string; email: string }> {
  const configId = process.env.SCRIPT_CONFIG_ID;
  const explicit = process.env.SCRIPT_USER_ID;
  const rows = configId
    ? await sql<{ id: string; email: string }[]>`
        select p.id, p.email from user_profiles p
        join configs c on c.user_id = p.id where c.id = ${configId} limit 1`
    : explicit
      ? await sql<{ id: string; email: string }[]>`
          select id, email from user_profiles where id = ${explicit} limit 1`
      : await sql<{ id: string; email: string }[]>`
          select id, email from user_profiles order by created_at limit 1`;
  if (rows.length === 0) throw new Error("No user_profiles row to run as.");
  return rows[0];
}

async function config(userId: string): Promise<{ id: string; label: string }> {
  const explicit = process.env.SCRIPT_CONFIG_ID;
  const rows = explicit
    ? await sql<{ id: string; label: string }[]>`
        select id, coalesce(name, id::text) as label from configs where id = ${explicit} limit 1`
    : await sql<{ id: string; label: string }[]>`
        select id, coalesce(name, id::text) as label from configs
        where user_id = ${userId} order by created_at desc limit 1`;
  if (rows.length === 0) throw new Error("No config to run against.");
  return rows[0];
}

// The same set lib/rag/evalStore.allLabeledQuestions counts, duplicated here
// because this harness cannot import it. Only the progress DENOMINATOR depends on
// it — the runner derives the real work from the step — so a drift here is
// cosmetic, not a wrong test.
async function labeledQuestionCount(
  configId: string,
  documentIds: string[] | null,
): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n
      from eval_questions q
      join eval_labels l on l.eval_question_id = q.id
      join document_embeddings de on de.id = l.document_embedding_id
     where de.config_id = ${configId}
       and (${documentIds}::uuid[] is null or q.document_id = any(${documentIds}::uuid[]))
  `;
  return Number(row.n);
}

// Chunks holding at least one labeled question — the denominator an autotune job
// is counted in. Same caveat as labeledQuestionCount: cosmetic, the step derives
// the real plan.
async function labeledChunkCount(configId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(distinct l.source_chunk_id) as n
      from eval_labels l
      join document_embeddings de on de.id = l.document_embedding_id
     where de.config_id = ${configId}
  `;
  return Number(row.n);
}

// Poll the row until it goes terminal, collecting every distinct phase the cursor
// passed through. Phases are minutes long and this polls every 500ms, so a phase
// that ran is a phase this saw — but the assertions below never require a phase to
// have been OBSERVED, only that the end state is consistent, so a missed sample
// cannot produce a false failure.
async function driveToEnd(jobId: string): Promise<{
  status: string;
  phases: string[];
  attempts: number;
  doneUnits: number;
  totalUnits: number;
  failedUnits: number;
  runId: string | null;
  error: string | null;
}> {
  const phases: string[] = [];
  for (;;) {
    const [job] = await sql<
      {
        status: string;
        attempts: number;
        done_units: number;
        total_units: number;
        failed_units: number;
        phase: string | null;
        run_id: string | null;
        lease_expires_at: Date | null;
        error: string | null;
      }[]
    >`
      select status, attempts, done_units, total_units, failed_units,
             cursor->>'phase' as phase, cursor->>'runId' as run_id,
             lease_expires_at, error
        from background_jobs where id = ${jobId}
    `;
    if (!job) throw new Error("No such job.");
    if (job.phase && phases.at(-1) !== job.phase) phases.push(job.phase);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      return {
        status: job.status,
        phases,
        attempts: job.attempts,
        doneUnits: job.done_units,
        totalUnits: job.total_units,
        failedUnits: job.failed_units,
        runId: job.run_id,
        error: job.error,
      };
    }
    // The runner chains its own slices; this only steps in when a slice died
    // without handing off, which is exactly what the janitor does in production.
    if (!job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now()) {
      await tick(jobId);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const TERMINAL = ["succeeded", "failed", "cancelled"];

type JobRow = {
  status: string;
  attempts: number;
  done_units: number;
  total_units: number;
  failed_units: number;
  last_message: string | null;
  error: string | null;
};

// A READ ON A CONNECTION THIS SCRIPT DOES NOT HOLD OPEN.
//
// The whole claim of the background path is that work continues with nobody
// attached, so proving it means letting go: this opens a connection, reads one
// row, and closes it again. Polling over the module-level handle would leave
// "the client was still connected" as an alternative explanation for every
// number the run reports, which is the one explanation the test exists to rule
// out.
async function readDetached(jobId: string): Promise<JobRow> {
  const one = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    ssl: sslFor(process.env.DATABASE_URL!),
    max: 1,
  });
  try {
    const [row] = await one<JobRow[]>`
      select status, attempts, done_units, total_units, failed_units, last_message, error
        from background_jobs where id = ${jobId}
    `;
    if (!row) throw new Error("No such job.");
    return row;
  } finally {
    await one.end();
  }
}

// Watch a job to its end WITHOUT EVER TICKING IT. driveToEnd() deliberately
// re-ticks a job whose lease has lapsed, which is right for the autotune harness
// — it is testing the step, and standing in for the janitor keeps a dead slice
// from ending the run. Here it would be fatal: a server that never chains its
// own next slice is precisely the failure this verb exists to catch, and a
// helpful re-tick from the client would paper over it and report a pass.
//
// So the only exit is the job going terminal on its own, or the timeout.
async function observeDetached(
  jobId: string,
  timeoutMs: number,
): Promise<{
  row: JobRow;
  maxAttempts: number;
  progressed: boolean;
  timedOut: boolean;
}> {
  const started = Date.now();
  let maxAttempts = 0;
  let firstSeenDone: number | null = null;
  let row = await readDetached(jobId);
  for (;;) {
    row = await readDetached(jobId);
    maxAttempts = Math.max(maxAttempts, row.attempts);
    if (firstSeenDone === null) firstSeenDone = row.done_units;
    const pct =
      row.total_units > 0
        ? Math.round((row.done_units / row.total_units) * 100)
        : 0;
    console.log(
      `    ${row.status.padEnd(11)} ${String(pct).padStart(3)}%  ` +
        `${row.done_units}/${row.total_units}  slices=${row.attempts}`,
    );
    if (TERMINAL.includes(row.status)) {
      return {
        row,
        maxAttempts,
        progressed: row.done_units > (firstSeenDone ?? 0),
        timedOut: false,
      };
    }
    if (Date.now() - started > timeoutMs) {
      return {
        row,
        maxAttempts,
        progressed: row.done_units > (firstSeenDone ?? 0),
        timedOut: true,
      };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// The document with the FEWEST labeled questions on this config. Slicing is a
// function of the slice budget, not of the unit count, so the cheapest scope
// that still slices is the right one to test on — a bigger sample buys no extra
// coverage and spends more to get it.
async function smallestLabeledDocument(configId: string): Promise<string> {
  const [row] = await sql<{ document_id: string; n: number }[]>`
    select q.document_id, count(*)::int as n
      from eval_questions q
      join eval_labels l on l.eval_question_id = q.id
      join document_embeddings de on de.id = l.document_embedding_id
     where de.config_id = ${configId}
     group by q.document_id
     order by n asc
     limit 1
  `;
  if (!row) throw new Error("No labeled document on this config to scope to.");
  return row.document_id;
}

async function launchRow(
  userId: string,
  cfg: { id: string; label: string },
  scope: unknown,
  totalUnits: number,
): Promise<string> {
  const [job] = await sql<{ id: string }[]>`
    insert into background_jobs
      (user_id, kind, config_id, config_label, scope, total_units, status)
    values (${userId}, 'rescore', ${cfg.id}, ${cfg.label},
            ${sql.json(scope as never)}, ${totalUnits}, 'queued')
    returning id
  `;
  return job.id;
}

// THE LOCK THE CI WORKFLOW RELIES ON. Every verb that SPENDS goes through here:
// a job that actually runs is provider calls against a real BYOK key, and a row
// in the live ledger that someone then has to explain. Requiring an explicit
// opt-in means a stray dispatch, or a mistyped verb, reads rather than writes.
//
// `cancel` and `sweep` are deliberately NOT gated. They are the recovery tools —
// what you reach for when a job is stuck — and a lock on those is a lock in the
// wrong place. `sweep` can start work indirectly by nudging a stalled job, which
// is the point of it; the spend was already committed when that job was launched.
function requireWrites(verb: string, cost: string): void {
  if (process.env.SMOKE_ALLOW_WRITES === "1") return;
  throw new Error(`${verb} ${cost} Set SMOKE_ALLOW_WRITES=1 to confirm.`);
}

function check(ok: boolean, what: string): boolean {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  return ok;
}

// Vercel's Deployment Protection sits IN FRONT of the app, so a protected preview
// answers 401 before any route runs and the job secret never gets a chance to
// matter. Same header scripts/smoke-deploy.ts sends, and absent on production,
// where there is no wall to get past.
function bypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

async function tick(jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/jobs/tick`, {
    method: "POST",
    headers: {
      ...bypassHeaders(),
      "content-type": "application/json",
      "x-job-signature": signJobTick(jobId),
    },
    body: JSON.stringify({ jobId }),
  });
  const body = await res.text();
  console.log(`tick -> ${res.status} ${body}`);
  // A 401 from the WALL and a 401 from the route read identically in a log but
  // mean opposite things: one is a missing bypass secret, the other is the job
  // signature the test is actually about. Say which, rather than leaving someone
  // to re-derive it from a deployment URL an hour later.
  if (res.status === 401 && !process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    console.log(
      "       ^ no VERCEL_AUTOMATION_BYPASS_SECRET set. On a protected preview this\n" +
        "         is Vercel's wall, not the job secret — the route never ran.",
    );
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const user = await owner();

  switch (command) {
    case "launch": {
      // `launch [kind] [documentId]` — kind defaults to rescore, the cheapest to
      // exercise repeatedly (it re-uses cached query vectors).
      requireWrites(
        "launch",
        "creates a job that re-scores real questions for real money.",
      );
      const kind =
        arg && arg.startsWith("rescore") ? "rescore" : (arg ?? "rescore");
      const docId = process.argv[4];
      const cfg = await config(user.id);
      const total = await labeledQuestionCount(cfg.id, docId ? [docId] : null);
      const scope = docId ? { documentIds: [docId] } : {};
      const [job] = await sql<{ id: string }[]>`
        insert into background_jobs
          (user_id, kind, config_id, config_label, scope, total_units, status)
        values (${user.id}, ${kind}, ${cfg.id}, ${cfg.label},
                ${sql.json(scope)}, ${total}, 'queued')
        returning id
      `;
      console.log(
        `launched ${kind} ${job.id} — ${total} question(s) on ${cfg.label}`,
      );
      await tick(job.id);
      break;
    }
    case "watch": {
      for (;;) {
        const [job] = await sql<
          {
            status: string;
            done_units: number;
            total_units: number;
            attempts: number;
            last_message: string | null;
            result: unknown;
            error: string | null;
          }[]
        >`
          select status, done_units, total_units, attempts, last_message, result, error
            from background_jobs where id = ${arg}
        `;
        if (!job) throw new Error("No such job.");
        const pct =
          job.total_units > 0
            ? Math.round((job.done_units / job.total_units) * 100)
            : "—";
        console.log(
          `${job.status.padEnd(11)} ${String(pct).padStart(3)}%  ` +
            `${job.done_units}/${job.total_units}  slices=${job.attempts}  ${job.last_message ?? ""}`,
        );
        if (["succeeded", "failed", "cancelled"].includes(job.status)) {
          console.log(`result: ${JSON.stringify(job.result)}`);
          if (job.error) console.log(`error: ${job.error}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      break;
    }
    case "cancel": {
      // Deliberately the same conditional the store's requestCancel writes: a
      // leased job gets the flag and stops itself, an idle one goes straight to
      // terminal because no slice would ever read the flag.
      const [job] = await sql<{ status: string }[]>`
        update background_jobs
           set status = case when lease_expires_at > now() then 'cancelling' else 'cancelled' end,
               finished_at = case when lease_expires_at > now() then null else now() end,
               updated_at = now()
         where id = ${arg} and status in ('queued', 'running')
        returning status
      `;
      console.log(`cancel -> ${job?.status ?? "not cancellable"}`);
      break;
    }
    case "autotune": {
      requireWrites("autotune", "runs a real tuning sweep for real money.");
      // Set JOBS_SLICE_BUDGET_MS small in the SERVER's environment first, or a
      // small config finishes its search in one slice and the multi-slice
      // assertion below proves nothing.
      const cfg = await config(user.id);
      const total = await labeledChunkCount(cfg.id);
      // The history rows that existed BEFORE this run. Asserting on the id the
      // cursor ended up holding would prove nothing — that id is the primary key
      // and insertAutotuneRun deletes-then-inserts under it, so it cannot
      // duplicate. The failure worth catching is a slice that lost the runId and
      // minted a fresh one, which shows up as two NEW rows, both singletons.
      const before = new Set(
        (
          await sql<
            { id: string }[]
          >`select id from autotune_runs where config_id = ${cfg.id}`
        ).map((r) => r.id),
      );
      const [job] = await sql<{ id: string }[]>`
        insert into background_jobs
          (user_id, kind, config_id, config_label, scope, total_units, status)
        values (${user.id}, 'autotune', ${cfg.id}, ${cfg.label}, ${sql.json({})}, ${total}, 'queued')
        returning id
      `;
      console.log(
        `autotune ${job.id} — up to ${total} chunk(s) on ${cfg.label}`,
      );
      await tick(job.id);
      const run = await driveToEnd(job.id);
      console.log(
        `\n${run.status} after ${run.attempts} slice(s); phases: ${run.phases.join(" → ")}` +
          `${run.error ? `\nerror: ${run.error}` : ""}\n`,
      );

      const added = await sql<
        {
          id: string;
          chunks_total: number | null;
          chunks_searched: number | null;
          chunks_failed: number | null;
          stop_reason: string | null;
          tail_status: string | null;
        }[]
      >`
        select id, chunks_total, chunks_searched, chunks_failed, stop_reason, tail_status
          from autotune_runs where config_id = ${cfg.id}
      `;
      const fresh = added.filter((r) => !before.has(r.id));
      const row = fresh[0];

      let ok = true;
      ok =
        check(run.status === "succeeded", `job succeeded (${run.status})`) &&
        ok;
      // One history row per RUN, however many slices it took. A slice that writes
      // it can die and be re-run — work commits before the cursor does — so the
      // carried runId is the only thing standing between that and an audit trail
      // with two copies of the same run in it.
      ok =
        check(
          fresh.length === 1,
          `exactly one new autotune_runs row (${fresh.length})`,
        ) && ok;
      ok =
        check(
          row?.id === run.runId,
          "the history row is the one the cursor carried",
        ) && ok;
      if (row) {
        // The §B property: a frozen plan is swept to its end. The old code's
        // slice 2 planned an empty sweep and this is the number that showed it.
        ok =
          check(
            row.chunks_searched === row.chunks_total,
            `swept the whole plan (${row.chunks_searched}/${row.chunks_total})`,
          ) && ok;
        // A hole in the sweep is allowed to exist but must be COUNTED — 0068's
        // whole point is that "74 searched" stopped meaning "74 worked".
        ok =
          check(
            (row.chunks_failed ?? 0) === run.failedUnits,
            `failed chunks agree: history=${row.chunks_failed} job=${run.failedUnits}`,
          ) && ok;
        // A yield is not a stop. If the tail's handing back to commit ever starts
        // writing a stop reason, every long run reports as truncated — and since
        // §C derives "Run again" from coverage, it would offer recovery on a run
        // that finished fine.
        ok =
          check(
            row.stop_reason === null,
            `stop_reason null (${row.stop_reason})`,
          ) && ok;
        ok =
          check(
            row.tail_status === null,
            `tail settled cleanly (${row.tail_status})`,
          ) && ok;
      }
      // The search has to have taken more than one slice for any of this to be a
      // test of slicing at all. Reported rather than asserted when the config is
      // too small to produce two — a true statement about a config, not a defect.
      if (run.attempts <= 1) {
        console.log(
          "\nNOTE: one slice only. Lower JOBS_SLICE_BUDGET_MS on the server, or use a " +
            "bigger config, or this run says nothing about slice boundaries.",
        );
      }
      console.log(ok ? "\nPASS" : "\nFAIL");
      if (!ok) process.exitCode = 1;
      break;
    }
    // THE VERB THAT PROVES THE BACKGROUND PATH, on the smallest scope that can.
    //
    // Four claims, in the order they have to hold:
    //   1. the tick ANSWERS before the work is done  (it runs inside after())
    //   2. the work continues with NOBODY ATTACHED   (the detached poll)
    //   3. the server CHAINS ITS OWN next slice      (attempts > 1, no client tick)
    //   4. a cancel mid-flight COMMITS PARTIAL WORK  (the flag, not a throw)
    //
    // Claims 3 and 4 are only meaningful when a job takes more than one slice, so
    // they are reported as INCONCLUSIVE rather than passing when it did not — a
    // green tick for "it chained" on a job that never had a second slice to chain
    // to is worse than no assertion at all.
    case "background": {
      requireWrites(
        "background",
        "runs two real rescore jobs against the deployment.",
      );
      const cfg = await config(user.id);
      const docId =
        arg ??
        process.env.SMOKE_DOCUMENT_ID ??
        (await smallestLabeledDocument(cfg.id));
      const total = await labeledQuestionCount(cfg.id, [docId]);
      const scope = { documentIds: [docId] };
      const timeout = Number(process.env.SMOKE_TIMEOUT_MS ?? 600_000);

      console.log(`config:   ${cfg.label}`);
      console.log(`document: ${docId} — ${total} labeled question(s)`);
      console.log(`base:     ${BASE}\n`);
      if (total === 0)
        throw new Error("That document has no labeled questions to score.");

      let ok = true;

      // ---- Job A — runs to completion with nobody watching -------------------
      console.log("A. launch, let go, and see whether it finishes alone");
      const a = await launchRow(user.id, cfg, scope, total);
      const t0 = Date.now();
      await tick(a);
      const ackMs = Date.now() - t0;

      // The ack has to arrive while the job is STILL LIVE. A 202 that only came
      // back once the row was terminal would mean the caller waited out the work,
      // which is the exact opposite of what after() is for.
      const atAck = await readDetached(a);
      ok = check(ackMs < 15_000, `tick acked in ${ackMs}ms`) && ok;
      ok =
        check(
          !TERMINAL.includes(atAck.status),
          `job still live when the ack landed (${atAck.status})`,
        ) && ok;

      const runA = await observeDetached(a, timeout);
      ok =
        check(
          !runA.timedOut,
          `job A reached a terminal state (${runA.row.status})`,
        ) && ok;
      ok =
        check(
          runA.row.status === "succeeded",
          `job A succeeded (${runA.row.status})`,
        ) && ok;
      ok =
        check(
          runA.row.done_units === runA.row.total_units,
          `every unit done (${runA.row.done_units}/${runA.row.total_units})`,
        ) && ok;
      ok =
        check(
          runA.row.failed_units === 0,
          `no failed units (${runA.row.failed_units})`,
        ) && ok;

      // The chaining claim. Nothing above ticked job A after the first one, so a
      // second slice can only have come from the server handing off to itself.
      if (runA.maxAttempts > 1) {
        ok =
          check(true, `server chained its own slices (${runA.maxAttempts})`) &&
          ok;
      } else {
        console.log(
          `  ~~    INCONCLUSIVE: job A took ${runA.maxAttempts} slice(s), so nothing was\n` +
            "        chained. Set JOBS_SLICE_BUDGET_MS small in the SERVER's environment\n" +
            "        to force a handoff; at the 240s default a job this size will not.",
        );
      }

      // ---- Job B — cancelled mid-flight --------------------------------------
      console.log("\nB. launch, cancel mid-flight, and see what it kept");
      const b = await launchRow(user.id, cfg, scope, total);
      await tick(b);

      // Wait for real work before pulling the plug: cancelling a job that has not
      // started yet exercises the idle branch, which is not the branch worth
      // testing. Give up after a while rather than hanging on a job that never ran.
      const waitUntil = Date.now() + Math.min(timeout, 120_000);
      let live = await readDetached(b);
      while (
        live.done_units === 0 &&
        !TERMINAL.includes(live.status) &&
        Date.now() < waitUntil
      ) {
        await new Promise((r) => setTimeout(r, 2000));
        live = await readDetached(b);
      }
      console.log(`    cancelling at ${live.done_units}/${live.total_units}`);

      if (live.done_units === 0 || TERMINAL.includes(live.status)) {
        console.log(
          `  ~~    INCONCLUSIVE: job B was ${live.status} with ${live.done_units} unit(s)\n` +
            "        done, so there was no mid-flight to cancel.",
        );
      } else {
        const atCancel = live.done_units;
        // The same conditional the store's requestCancel writes — see the `cancel`
        // verb. A leased job gets the flag and stops itself; an idle one goes
        // straight to terminal because no slice would ever read the flag.
        await sql`
          update background_jobs
             set status = case when lease_expires_at > now() then 'cancelling' else 'cancelled' end,
                 finished_at = case when lease_expires_at > now() then null else now() end,
                 updated_at = now()
           where id = ${b} and status in ('queued', 'running')
        `;
        const runB = await observeDetached(b, timeout);
        ok =
          check(
            !runB.timedOut,
            `job B reached a terminal state (${runB.row.status})`,
          ) && ok;
        ok =
          check(
            runB.row.status === "cancelled",
            `job B ended cancelled (${runB.row.status})`,
          ) && ok;
        // The cancel is a FLAG the step breaks on, not a throw, so the units it
        // had already scored must still be there. Work going backwards would mean
        // something rolled back a committed slice.
        ok =
          check(
            runB.row.done_units >= atCancel,
            `partial work kept (${atCancel} → ${runB.row.done_units})`,
          ) && ok;
      }

      console.log(ok ? "\nPASS" : "\nFAIL");
      if (!ok) process.exitCode = 1;
      break;
    }
    case "abandon": {
      // Manufacture the state §D.1 exists for: results stamped under a retrieval
      // state that is not the current one, i.e. what a run that committed
      // overrides and then died leaves behind. The next autotune must run
      // `settle` and still plan a non-empty sweep — the failure it guards against
      // is "nothing to target" over a config that plainly needs tuning.
      //
      // THIS RE-SCORES REAL QUESTIONS on the next run, which costs real provider
      // calls, so it is opt-in rather than something a stray argument can trigger.
      requireWrites(
        "abandon",
        "rewrites eval_results stamps and makes the next run re-score them for real money.",
      );
      const cfg = await config(user.id);
      const stamped = await sql`
        update eval_results r
           set retrieval_state = 'abandoned-run'
          from eval_labels l
          join document_embeddings de on de.id = l.document_embedding_id
         where r.eval_label_id = l.id
           and de.config_id = ${cfg.id}
           and not r.is_baseline
      `;
      console.log(
        `stamped ${stamped.count} result(s) on ${cfg.label} as abandoned.\n` +
          `now run: npm run jobs:smoke -- autotune\n` +
          `expect the phase list to START with 'settle', and the sweep to be non-empty.`,
      );
      break;
    }
    case "sweep": {
      const res = await fetch(`${BASE}/api/jobs/tick`, {
        headers: {
          ...bypassHeaders(),
          authorization: `Bearer ${process.env.JOBS_SECRET ?? sweepSecret()}`,
        },
      });
      console.log(`sweep -> ${res.status} ${await res.text()}`);
      break;
    }
    default: {
      const jobs = await sql<
        {
          id: string;
          kind: string;
          status: string;
          done_units: number;
          total_units: number;
          created_at: Date;
        }[]
      >`
        select id, kind, status, done_units, total_units, created_at
          from background_jobs where user_id = ${user.id}
         order by created_at desc limit 10
      `;
      for (const j of jobs) {
        console.log(
          `${j.id}  ${j.kind.padEnd(9)} ${j.status.padEnd(11)} ` +
            `${j.done_units}/${j.total_units}  ${j.created_at.toISOString()}`,
        );
      }
    }
  }
}

// Mirrors jobSecret.ts's fallback, for the sweep's bearer form.
function sweepSecret(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", "rag-jobs")
    .update(process.env.DATABASE_URL!)
    .digest("hex");
}

main().then(
  async () => {
    await sql.end();
    process.exit(0);
  },
  async (e) => {
    console.error(e);
    await sql.end();
    process.exit(1);
  },
);
