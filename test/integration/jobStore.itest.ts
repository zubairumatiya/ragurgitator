// The job store's two column lists, against a real database.
//
// `cursor` is ~96% of a job row and only the lease claim resumes from it, so
// every other reader selects JOB_COLUMNS_LIGHT and `BackgroundJob.cursor` is
// optional. That split is invisible to a unit test — both halves type-check
// either way — and the failure it could cause is silent in the worst possible
// place: a claim that came back without a cursor would restart a half-finished
// job from zero and re-spend everything it had already paid for.
//
// So this asserts both directions on a real row: the light readers must NOT
// carry a cursor (that is the saving) and claimJob MUST carry the exact cursor a
// mid-run checkpoint committed (that is the resume).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql, sql } from "../../lib/db";
import {
  activeJobsForConfig,
  checkpointJob,
  claimJob,
  createJob,
  getJob,
  listJobs,
  listStalledJobs,
} from "../../lib/jobs/store";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };
let configId: string;

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

beforeEach(async () => {
  await truncateAll(admin);
  alice = await createUser(admin);
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('c', ${alice.id}) returning id`;
  const [config] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${alice.id}, ${corpus.id}, 'voyage-4-lite', 500, 50, 5, 'llm') returning id`;
  configId = config.id;
});

const asAlice = <T>(fn: () => Promise<T>) =>
  withUser({ id: alice.id, email: alice.email }, fn);

// A cursor big enough that shipping it to every reader is the cost this phase
// removes: autotune's real one carries a frozen retrieval state.
const START = { phase: "plan", runId: "r0", pending: Array.from({ length: 200 }, (_, i) => i) };
const MIDRUN = { phase: "search", runId: "r0", pending: [7, 8, 9], done: 197 };

async function newJob() {
  return createJob({
    kind: "autotune",
    configId,
    configLabel: "cfg",
    scope: { documentIds: null },
    cursor: START,
    totalUnits: 200,
  });
}

describe("job store column lists", () => {
  it("keeps the cursor off every list reader, including createJob's returning", async () => {
    await asAlice(async () => {
      const created = await newJob();
      assert.equal(created.cursor, undefined, "createJob returning");

      const fetched = await getJob(created.id);
      assert.ok(fetched);
      assert.equal(fetched.cursor, undefined, "getJob");
      // The rest of the row still arrives — this is a narrower select, not a
      // broken one.
      assert.deepEqual(fetched.scope, { documentIds: null });
      assert.equal(fetched.totalUnits, 200);
      assert.equal(fetched.status, "queued");

      const [listed] = await listJobs();
      assert.equal(listed.cursor, undefined, "listJobs");

      const [stalled] = await listStalledJobs();
      assert.equal(stalled.cursor, undefined, "listStalledJobs");

      const [active] = await activeJobsForConfig(configId);
      assert.equal(active.cursor, undefined, "activeJobsForConfig");
      const [activeKind] = await activeJobsForConfig(configId, ["autotune"]);
      assert.equal(activeKind.cursor, undefined, "activeJobsForConfig(kinds)");
    });
  });

  it("hands claimJob the cursor a mid-run checkpoint committed", async () => {
    await asAlice(async () => {
      const created = await newJob();

      // Slice one: claim, and resume from the cursor createJob stored.
      const first = await claimJob(created.id, 60);
      assert.ok(first, "first claim");
      assert.deepEqual(first.job.cursor, START, "the start cursor survives the claim");
      assert.equal(first.job.status, "running");

      assert.equal(await checkpointJob(created.id, first.leaseToken, { cursor: MIDRUN, doneUnits: 197 }), true);

      // The lease has to lapse before a second slice can take it — that is the
      // resume this test exists for, not a same-slice read-back.
      // In-scope, not on `admin`: a user scope IS a transaction (0051), so an
      // outside connection would block on the row this one already wrote.
      await sql`update background_jobs set lease_expires_at = now() - interval '1 second'
                 where id = ${created.id}`;

      const second = await claimJob(created.id, 60);
      assert.ok(second, "second claim");
      assert.deepEqual(second.job.cursor, MIDRUN, "the resumed slice sees where the last one got to");
      assert.equal(second.job.doneUnits, 197);
      assert.notEqual(second.leaseToken, first.leaseToken);

      // ...and the light readers still do not carry it, mid-run.
      const light = await getJob(created.id);
      assert.equal(light?.cursor, undefined);
      assert.equal(light?.doneUnits, 197);
    });
  });
});
