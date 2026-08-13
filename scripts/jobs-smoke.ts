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
//   npm run jobs:smoke                          list the ten newest jobs
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

import { signJobTick } from "../lib/http/jobSecret";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });
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
async function labeledQuestionCount(configId: string, documentIds: string[] | null): Promise<number> {
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

async function tick(jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/jobs/tick`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-job-signature": signJobTick(jobId) },
    body: JSON.stringify({ jobId }),
  });
  console.log(`tick -> ${res.status} ${await res.text()}`);
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const user = await owner();

  switch (command) {
    case "launch": {
      // `launch [kind] [documentId]` — kind defaults to rescore, the cheapest to
      // exercise repeatedly (it re-uses cached query vectors).
      const kind = arg && arg.startsWith("rescore") ? "rescore" : (arg ?? "rescore");
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
      console.log(`launched ${kind} ${job.id} — ${total} question(s) on ${cfg.label}`);
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
        const pct = job.total_units > 0 ? Math.round((job.done_units / job.total_units) * 100) : "—";
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
    case "sweep": {
      const res = await fetch(`${BASE}/api/jobs/tick`, {
        headers: { authorization: `Bearer ${process.env.JOBS_SECRET ?? sweepSecret()}` },
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
  return createHmac("sha256", "rag-jobs").update(process.env.DATABASE_URL!).digest("hex");
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
