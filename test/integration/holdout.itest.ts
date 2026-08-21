// What a run remembers about the questions it was FORBIDDEN to see (0074).
//
// This tier exists for the parts of the feature that are properties of the
// SCHEMA and of SQL rather than of any pure function, and there are three:
//
//   1. The snapshot survives the redraw. syncHoldout deletes every 'holdout' row
//      on a settings save, so the whole point of autotune_run_holdout is that a
//      finished run's test set outlives the membership it was drawn from. A unit
//      test cannot demonstrate that; it needs the two tables side by side.
//   2. Contamination is a join against OTHER runs' rows. The one-way door — a
//      question that an earlier run tuned on can never again measure
//      generalization — is decided by a query, and the query is the feature.
//   3. Re-running a slice replaces rather than doubles. insertAutotuneRun's
//      idempotency now depends on `delete from autotune_runs` CASCADING into a
//      table 0016 never knew about, which is a fact about the FK and not about
//      the function.
//
// No provider is called and nothing is scored: every value here is written
// directly, because what is under test is the recording, not the measuring.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql } from "../../lib/db";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import {
  type AutotuneRunHeader,
  type HoldoutCapture,
  HOLDOUT_REASON,
  holdoutContaminated,
  insertAutotuneRun,
  listHoldoutRunQuestions,
  listHoldoutRuns,
} from "../../lib/rag/autotuneStore";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

let admin: Sql;
let alice: { id: string; email: string };
let configId: string;
let questionIds: string[];

async function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return withUser(alice, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

// The non-holdout half of a header. Every field is a stated constant so a test
// that cares about one of them can say so without the others being in the way.
function header(over: Partial<AutotuneRunHeader> = {}): AutotuneRunHeader {
  return {
    recallK: 5,
    recallMinRate: 0.8,
    mrrK: 5,
    mrrMinRate: null,
    ndcgK: 5,
    ndcgMinRate: null,
    targeted: 0,
    resolved: 0,
    unresolved: 0,
    improved: 0,
    attempts: 0,
    stopReason: null,
    chunksTotal: 0,
    chunksSearched: 0,
    chunksFailed: 0,
    tailStatus: null,
    holdout: null,
    ...over,
  };
}

// A capture over `members`, with recall moving from `before` to `after` on the
// holdout side. The per-question rows are consistent with that: the first
// `hits` of them end as hits.
function capture(members: string[], hits: number): HoldoutCapture {
  return {
    dials: { mode: "pct", size: 25, seed: 1 },
    splitKey: "abc123abc123",
    before: {
      train: { n: 4, recall: 0.5, mrr: 0.5, ndcg: 0.5 },
      holdout: { n: members.length, recall: 0, mrr: 0, ndcg: 0 },
    },
    after: {
      train: { n: 4, recall: 0.9, mrr: 0.8, ndcg: 0.7 },
      holdout: { n: members.length, recall: hits / members.length, mrr: 0.4, ndcg: 0.3 },
    },
    rows: members.map((questionId, i) => ({
      questionId,
      beforeHit: false,
      beforeRank: null,
      beforeRr: 0,
      beforeNdcg: 0,
      afterHit: i < hits,
      afterRank: i < hits ? 2 : null,
      afterRr: i < hits ? 0.5 : 0,
      afterNdcg: i < hits ? 0.6 : 0,
    })),
  };
}

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
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${alice.id}, ${corpus.id}, 'voyage-4-lite', 500, 50, 5, 'claude-sonnet-4-6')
    returning id`;
  configId = cfg.id;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('d.txt', ${`h-${alice.id}`}, 'body', ${alice.id}) returning id`;
  const rows = await admin<{ id: string }[]>`
    insert into eval_questions (document_id, question)
    select ${doc.id}, 'q' || g from generate_series(1, 4) as g
    returning id`;
  questionIds = rows.map((r) => r.id);
});

describe("the frozen holdout snapshot", () => {
  it("survives the redraw that destroys the membership it came from", async () => {
    const members = questionIds.slice(0, 2);
    // The membership as the draw writes it: rows in config_question_ignores.
    await admin`
      insert into config_question_ignores (config_id, eval_question_id, reason)
      select ${configId}, id, ${HOLDOUT_REASON} from unnest(${members}::uuid[]) as id`;

    const runId = crypto.randomUUID();
    await inScope(() => insertAutotuneRun(runId, header({ holdout: capture(members, 1) }), []));

    // …and now the redraw eats it, exactly as syncHoldout does on a settings save.
    await admin`delete from config_question_ignores
      where config_id = ${configId} and reason = ${HOLDOUT_REASON}`;

    const questions = await inScope(() => listHoldoutRunQuestions(runId));
    assert.equal(questions.length, 2, "the run's test set did not outlive the redraw");
    assert.deepEqual(new Set(questions.map((q) => q.questionId)), new Set(members));
  });

  it("reports both sides at both ends, never a holdout number alone", async () => {
    const members = questionIds.slice(0, 2);
    const runId = crypto.randomUUID();
    await inScope(() => insertAutotuneRun(runId, header({ holdout: capture(members, 1) }), []));

    const [run] = await inScope(() => listHoldoutRuns());
    assert.equal(run.holdout.n, 2);
    assert.equal(run.train.n, 4);
    // The pairing is the contract: neither side may come back half-populated.
    assert.equal(run.train.recall.before, 0.5);
    assert.equal(run.train.recall.after, 0.9);
    assert.equal(run.holdout.recall.before, 0);
    assert.equal(run.holdout.recall.after, 0.5);
    assert.deepEqual(run.dials, { mode: "pct", size: 25, seed: 1 });
    assert.equal(run.splitKey, "abc123abc123");
  });

  it("omits runs that recorded no holdout rather than showing them as zero", async () => {
    await inScope(() => insertAutotuneRun(crypto.randomUUID(), header(), []));
    assert.deepEqual(await inScope(() => listHoldoutRuns()), []);
  });

  it("replaces its rows when a slice is re-run, rather than doubling them", async () => {
    const members = questionIds.slice(0, 2);
    const runId = crypto.randomUUID();
    // Same id twice: the durability contract is that a slice which commits its
    // work and dies before its cursor moves can be re-run.
    await inScope(() => insertAutotuneRun(runId, header({ holdout: capture(members, 0) }), []));
    await inScope(() => insertAutotuneRun(runId, header({ holdout: capture(members, 2) }), []));

    const questions = await inScope(() => listHoldoutRunQuestions(runId));
    assert.equal(questions.length, 2, "the cascade did not clear the previous rows");
    assert.ok(
      questions.every((q) => q.afterHit === true),
      "the re-run's values did not replace the first attempt's",
    );
    assert.equal((await inScope(() => listHoldoutRuns())).length, 1);
  });
});

describe("contamination — the one-way door", () => {
  it("flags a run that held out a question an earlier run targeted", async () => {
    const tuned = questionIds[0];
    const first = crypto.randomUUID();
    await inScope(() =>
      insertAutotuneRun(first, header({ targeted: 1 }), [
        {
          questionId: tuned,
          sourceChunkId: crypto.randomUUID(),
          metric: "recall",
          beforeValue: 0,
          beforeRank: null,
          afterValue: 1,
          afterRank: 1,
          overrideKind: "size",
          overrideModel: null,
          overrideSize: 400,
        },
      ]),
    );

    const second = crypto.randomUUID();
    await inScope(() =>
      insertAutotuneRun(second, header({ holdout: capture([tuned, questionIds[1]], 1) }), []),
    );

    const runs = await inScope(() => listHoldoutRuns());
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, second);
    assert.equal(runs[0].contaminated, true);
  });

  it("does not flag a run for its own targeted questions", async () => {
    // A run tunes chunk A's questions and is tested on B's. Its own outcome rows
    // are in the table by the time the header is written, so excluding THIS run
    // is what stops every holdout from being born contaminated.
    const runId = crypto.randomUUID();
    await inScope(() =>
      insertAutotuneRun(runId, header({ targeted: 1, holdout: capture([questionIds[1]], 1) }), [
        {
          questionId: questionIds[0],
          sourceChunkId: crypto.randomUUID(),
          metric: "recall",
          beforeValue: 0,
          beforeRank: null,
          afterValue: 1,
          afterRank: 1,
          overrideKind: null,
          overrideModel: null,
          overrideSize: null,
        },
      ]),
    );
    const [run] = await inScope(() => listHoldoutRuns());
    assert.equal(run.contaminated, false);
  });

  it("is scoped to the config: another config's tuning does not contaminate this one", async () => {
    const [other] = await admin<{ id: string }[]>`
      insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
      select ${alice.id}, corpus_id, base_model, 250, 25, 5, llm_model from configs where id = ${configId}
      returning id`;
    const [otherRun] = await admin<{ id: string }[]>`
      insert into autotune_runs (config_id) values (${other.id}) returning id`;
    await admin`
      insert into autotune_question_outcomes
        (autotune_run_id, eval_question_id, source_chunk_id, metric)
      values (${otherRun.id}, ${questionIds[0]}, ${crypto.randomUUID()}, 'recall')`;

    // The same question, held out under OUR config. Retrieval differs per config,
    // so a chunk reshaped over there proves nothing about the model here.
    const contaminated = await inScope(() =>
      holdoutContaminated(crypto.randomUUID(), [questionIds[0]]),
    );
    assert.equal(contaminated, false);
  });

  it("is false, not null, for an empty test set", async () => {
    assert.equal(await inScope(() => holdoutContaminated(crypto.randomUUID(), [])), false);
  });
});
