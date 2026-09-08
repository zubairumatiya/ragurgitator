// THE DEMO'S RETRIEVAL BANK, against a real database — phase 1 of
// docs/demo-retrieval-bank-plan.md.
//
// A guest's re-score reads a banked ranked list instead of retrieving, and the
// whole design rests on five things a unit test cannot see because each is a
// join, a clone, or a scope:
//
//   1. A REAL ACCOUNT READS NULL. The bank sits under their id and scoreQuestions
//      still computes; readRetrievalBank returns null in their scope.
//   2. A HIT IS FIELD-FOR-FIELD THE COMPUTED ROW. The row the banked path inserts
//      into eval_results is what the computed path inserted for the same
//      question — retrieved_ids, retrieved_scores, k, hit, found_rank,
//      retrieval_state, screen_cutoffs — and it did so with NO retrieval: the
//      question's vector is deleted first, so an attempt to retrieve would have
//      had to embed, and there is no provider here to do it.
//   3. AN EDITED WORDING MISSES and computes, with the bank sitting right there.
//   4. CLONE STEP 5l rewrites a hash-form bank into the destination's ids, holds
//      a null for a hash that names no chunk there, and stamps `form: 'id'`.
//   5. A NULL MAKES THAT QUESTION MISS while its neighbour still hits — asserted
//      through a real scoreQuestions in the cloned guest.
//   6. THE PORTABLE KEY IS PORTABLE: the same override set over the same corpus
//      keys identically in the seed and in a clone of it, while the real
//      fingerprint differs — which is what lets one bank serve every guest.
//
// The bank in tests 1, 3 and 5 is a TELL-TALE: a list the real retrieval could
// never return (reversed, with its scores). So "computed" and "banked" are two
// different rows, and which one landed is read off the table rather than
// inferred from timing.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql } from "../../lib/db";
import { cloneSeedWorkspace } from "../../lib/demo/clone";
import { forgetRetrieval, readRetrievalBank, writeRetrieval } from "../../lib/demo/replay";
import { textHash, type ReplayRetrieval } from "../../lib/demo/replayCore";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { scoreQuestions } from "../../lib/rag/eval";
import { getQuestionToScore } from "../../lib/rag/evalStore";
import { portableRetrievalKey, retrievalStateFingerprint } from "../../lib/rag/overrideStore";
import { chunksTable, vectorLiteral } from "../../lib/rag/vectorStore";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const BASE_MODEL = "voyage-4-lite";
const DIM = 1024;
const CHUNKS = chunksTable(BASE_MODEL, DIM);

// A unit vector in the (e0, e1) plane whose cosine against e0 is exactly `c`
// (fusionPool.itest's trick), so every rank below is a stated constant.
const atCosine = (c: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
};
const E0 = atCosine(1);

const QUESTION = "which chunk?";
const OTHER = "and the other one?";
const BASE_SCORES = [0.9, 0.8, 0.7];
const TEXT = (i: number) => `chunk text number ${i}`;

type ResultRow = {
  retrieved_ids: (string | null)[];
  retrieved_scores: number[];
  k: number;
  hit: boolean;
  found_rank: number | null;
  retrieval_state: string;
  screen_cutoffs: { depth: number; deep: number | null; models: Record<string, number> };
};

let admin: Sql;
let user: { id: string; email: string };
let configId: string;
let chunkIds: string[];
let questionId: string;
let otherId: string;

async function inScope<T>(u: { id: string; email: string }, cfgId: string, fn: () => Promise<T>): Promise<T> {
  return withUser(u, async () => {
    const cfg = await resolveConfig(cfgId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

async function makeGuest(id: string) {
  await admin`
    update user_profiles set is_guest = true, expires_at = now() + interval '2 hours'
     where id = ${id}`;
}

// A workspace: one document over three chunks at descending cosines against
// the query, two labelled questions (both on chunk 0), and their query vectors
// cached so nothing embeds. Returns the ids the tests name.
async function seedWorkspace(owner: { id: string }) {
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('bank corpus', ${owner.id}) returning id`;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('a.txt', ${textHash("a")}, 'the body', ${owner.id}) returning id`;
  await admin`insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${doc.id})`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${owner.id}, ${corpus.id}, ${BASE_MODEL}, 500, 50, 3, 'test-llm') returning id`;
  const [run] = await admin<{ id: string }[]>`
    insert into document_embeddings
      (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
    values (${doc.id}, ${BASE_MODEL}, ${DIM}, 500, 50, ${BASE_SCORES.length}, ${cfg.id})
    returning id`;
  const ids: string[] = [];
  for (const [i, score] of BASE_SCORES.entries()) {
    const [row] = await admin<{ id: string }[]>`
      insert into ${admin(CHUNKS)}
        (document_id, document_embedding_id, position, text, embedding, config_id)
      values (${doc.id}, ${run.id}, ${i}, ${TEXT(i)}, ${vectorLiteral(atCosine(score))}, ${cfg.id})
      returning id`;
    ids.push(row.id);
  }
  const questions: string[] = [];
  for (const text of [QUESTION, OTHER]) {
    const [q] = await admin<{ id: string }[]>`
      insert into eval_questions (document_id, question) values (${doc.id}, ${text}) returning id`;
    await admin`
      insert into eval_labels (eval_question_id, document_embedding_id, source_chunk_id)
      values (${q.id}, ${run.id}, ${ids[0]})`;
    await admin`
      insert into eval_question_embeddings (eval_question_id, model, embedding)
      values (${q.id}, ${BASE_MODEL}, ${`{${E0.join(",")}}`}::real[])`;
    questions.push(q.id);
  }
  return { configId: cfg.id, chunkIds: ids, questionId: questions[0], otherId: questions[1] };
}

async function score(u: { id: string; email: string }, cfgId: string, qId: string) {
  await inScope(u, cfgId, async () => {
    const q = await getQuestionToScore(qId);
    assert.ok(q, "question fixture did not resolve");
    await scoreQuestions([q]);
  });
}

async function latestResult(qId: string): Promise<ResultRow> {
  const [row] = await admin<ResultRow[]>`
    select retrieved_ids, retrieved_scores, k, hit, found_rank, retrieval_state, screen_cutoffs
      from eval_results where eval_question_id = ${qId} and not is_baseline
     order by scored_at desc limit 1`;
  assert.ok(row, "no result row landed");
  return row;
}

// The tell-tale: the true list reversed. No retrieval over this fixture can
// return it, so a row carrying it was banked and a row not carrying it was
// computed.
const TELL_TALE = (ids: string[], depth: number): ReplayRetrieval["questions"][string] => ({
  ids: [...ids].reverse(),
  scores: [0.1, 0.2, 0.3],
  cutoffs: { depth, deep: null, models: { [BASE_MODEL]: 0.1 } },
});

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
  // The bank is memoed per process and per (user, key); a truncate is the one
  // write that memo's argument does not cover.
  forgetRetrieval();
  user = await createUser(admin);
  ({ configId, chunkIds, questionId, otherId } = await seedWorkspace(user));
});

describe("the retrieval bank's read path", () => {
  it("1. a real account reads null and computes, with the bank sitting under its id", async () => {
    const computed = await score(user, configId, questionId).then(() => latestResult(questionId));
    assert.deepEqual(computed.retrieved_ids, chunkIds, "the fixture's own rank");

    await writeRetrieval(user.id, "baseline", {
      version: 1,
      form: "id",
      depth: computed.screen_cutoffs.depth,
      questions: { [textHash(QUESTION)]: TELL_TALE(chunkIds, computed.screen_cutoffs.depth) },
    }, privilegedSql);
    await admin`delete from eval_results`;

    const read = await inScope(user, configId, () => readRetrievalBank("baseline"));
    assert.equal(read, null, "a real account must read null");

    const again = await score(user, configId, questionId).then(() => latestResult(questionId));
    assert.deepEqual(again.retrieved_ids, chunkIds, "a real account was served the bank");
  });

  it("2. a guest's hit inserts the computed row field for field, and retrieves nothing", async () => {
    await makeGuest(user.id);
    const computed = await score(user, configId, questionId).then(() => latestResult(questionId));
    assert.equal(computed.retrieval_state, "baseline");

    const key = await inScope(user, configId, () => portableRetrievalKey());
    assert.equal(key, "baseline", "no overrides ⇒ the portable key is the word");
    await writeRetrieval(user.id, key, {
      version: 1,
      form: "id",
      depth: computed.screen_cutoffs.depth,
      questions: {
        [textHash(QUESTION)]: {
          ids: computed.retrieved_ids as string[],
          scores: computed.retrieved_scores,
          cutoffs: computed.screen_cutoffs,
        },
      },
    }, privilegedSql);
    await admin`delete from eval_results`;
    // No vector anywhere: a retrieval would have to embed, and there is no key.
    await admin`delete from eval_question_embeddings`;
    await admin`delete from embedding_cache`;

    const banked = await score(user, configId, questionId).then(() => latestResult(questionId));
    assert.deepEqual(banked, computed);
  });

  it("3. an edited wording misses and computes", async () => {
    await makeGuest(user.id);
    const depth = (await score(user, configId, questionId).then(() => latestResult(questionId)))
      .screen_cutoffs.depth;
    await writeRetrieval(user.id, "baseline", {
      version: 1,
      form: "id",
      depth,
      questions: { [textHash(QUESTION)]: TELL_TALE(chunkIds, depth) },
    }, privilegedSql);
    await admin`delete from eval_results`;

    // The tell-tale is served for the banked wording...
    const hit = await score(user, configId, questionId).then(() => latestResult(questionId));
    assert.deepEqual(hit.retrieved_ids, [...chunkIds].reverse());
    await admin`delete from eval_results`;

    // ...and not once the wording moves. (The id-keyed vector cache still holds
    // the vector, so the computed path has one to retrieve with.)
    await admin`update eval_questions set question = ${QUESTION + " (edited)"} where id = ${questionId}`;
    const miss = await score(user, configId, questionId).then(() => latestResult(questionId));
    assert.deepEqual(miss.retrieved_ids, chunkIds);
  });
});

describe("clone step 5l", () => {
  let guest: { id: string; email: string };

  beforeEach(async () => {
    guest = await createUser(admin);
    await makeGuest(guest.id);
  });

  const guestChunks = async (): Promise<string[]> =>
    (await admin.unsafe<{ id: string }[]>(
      `select c.id from "${CHUNKS}" c join configs g on g.id = c.config_id
        where g.user_id = $1 order by c.position`,
      [guest.id],
    )).map((r) => r.id);

  it("4. rewrites a hash-form bank into the destination's ids, with a null for a hash that names no chunk", async () => {
    await writeRetrieval(user.id, "baseline", {
      version: 1,
      form: "hash",
      depth: 3,
      questions: {
        [textHash(QUESTION)]: {
          ids: [textHash(TEXT(0)), textHash("a passage this corpus does not have"), textHash(TEXT(2))],
          scores: [0.9, 0.5, 0.7],
          cutoffs: { depth: 3, deep: null, models: { [BASE_MODEL]: 0.7 } },
        },
        [textHash(OTHER)]: {
          ids: [textHash(TEXT(2)), textHash(TEXT(1)), textHash(TEXT(0))],
          scores: [0.7, 0.8, 0.9],
          cutoffs: { depth: 3, deep: null, models: { [BASE_MODEL]: 0.9 } },
        },
      },
    }, privilegedSql);

    const summary = await cloneSeedWorkspace(user.id, guest.id);
    assert.equal(summary.bankedRetrievalStates, 1);
    assert.equal(summary.bankedRetrievalQuestions, 2);
    assert.equal(summary.bankedRetrievalHoles, 1);

    const gc = await guestChunks();
    assert.equal(gc.length, 3);
    const [row] = await admin<{ key: string; payload: ReplayRetrieval }[]>`
      select key, payload from demo_replay where user_id = ${guest.id} and kind = 'retrieval'`;
    assert.equal(row.key, "baseline");
    assert.equal(row.payload.form, "id");
    assert.equal(row.payload.depth, 3);
    assert.deepEqual(row.payload.questions[textHash(QUESTION)].ids, [gc[0], null, gc[2]]);
    assert.deepEqual(row.payload.questions[textHash(OTHER)].ids, [gc[2], gc[1], gc[0]]);
    // Scores and cutoffs travel untouched.
    assert.deepEqual(row.payload.questions[textHash(OTHER)].scores, [0.7, 0.8, 0.9]);
    // And no seed chunk id leaked anywhere in the payload.
    const text = JSON.stringify(row.payload);
    for (const id of chunkIds) assert.ok(!text.includes(id), `seed id ${id} in the guest's bank`);
  });

  it("5. in the clone, the holed question computes and its neighbour hits", async () => {
    // Depth first, from a computed row on the seed side: the bank must be at
    // the depth the guest's config scores at, which the clone copies.
    const depth = (await score(user, configId, questionId).then(() => latestResult(questionId)))
      .screen_cutoffs.depth;
    await admin`delete from eval_results`;
    await writeRetrieval(user.id, "baseline", {
      version: 1,
      form: "hash",
      depth,
      questions: {
        [textHash(QUESTION)]: {
          ids: [textHash("a passage this corpus does not have"), textHash(TEXT(1)), textHash(TEXT(0))],
          scores: [0.1, 0.2, 0.3],
          cutoffs: { depth, deep: null, models: { [BASE_MODEL]: 0.1 } },
        },
        // The tell-tale, in hash form.
        [textHash(OTHER)]: {
          ids: [textHash(TEXT(2)), textHash(TEXT(1)), textHash(TEXT(0))],
          scores: [0.1, 0.2, 0.3],
          cutoffs: { depth, deep: null, models: { [BASE_MODEL]: 0.1 } },
        },
      },
    }, privilegedSql);
    await cloneSeedWorkspace(user.id, guest.id);

    const [gCfg] = await admin<{ id: string }[]>`select id from configs where user_id = ${guest.id}`;
    const gq = await admin<{ id: string; question: string }[]>`
      select q.id, q.question from eval_questions q join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;
    const gQuestion = gq.find((q) => q.question === QUESTION)!.id;
    const gOther = gq.find((q) => q.question === OTHER)!.id;
    const gc = await guestChunks();

    const holed = await score(guest, gCfg.id, gQuestion).then(() => latestResult(gQuestion));
    assert.deepEqual(holed.retrieved_ids, gc, "the holed question must compute");
    const hit = await score(guest, gCfg.id, gOther).then(() => latestResult(gOther));
    assert.deepEqual(hit.retrieved_ids, [...gc].reverse(), "the intact neighbour must hit");
  });

  it("6. the same override set keys identically in the seed and its clone, while the fingerprints differ", async () => {
    const install = async (cfgId: string, chunkId: string) => admin`
      insert into config_chunk_overrides
        (config_id, source_chunk_id, piece_index, model, dimension, kind, text, token_start, token_end, embedding)
      values (${cfgId}, ${chunkId}, 0, 'voyage-4', ${DIM}, 'size', 'a piece', 0, 10,
              ${`{${atCosine(0.95).join(",")}}`}::real[]),
             (${cfgId}, ${chunkId}, 1, 'voyage-4', ${DIM}, 'size', 'another piece', 10, 20,
              ${`{${atCosine(0.5).join(",")}}`}::real[])`;
    await install(configId, chunkIds[1]);
    await cloneSeedWorkspace(user.id, guest.id);
    // Overrides are not cloned (step 4b's note); a guest reaches this set by
    // installing it from the tuning bank. Here it is installed by hand on the
    // chunk with the same TEXT, which is what the key is supposed to see.
    const [gCfg] = await admin<{ id: string }[]>`select id from configs where user_id = ${guest.id}`;
    const gc = await guestChunks();
    await install(gCfg.id, gc[1]);

    const seedSide = await inScope(user, configId, async () => [
      await portableRetrievalKey(),
      await retrievalStateFingerprint(),
    ]);
    const guestSide = await inScope(guest, gCfg.id, async () => [
      await portableRetrievalKey(),
      await retrievalStateFingerprint(),
    ]);
    assert.notEqual(seedSide[0], "baseline");
    assert.equal(seedSide[0], guestSide[0], "the portable key must not see chunk ids");
    assert.notEqual(seedSide[1], guestSide[1], "the real fingerprint must");
    assert.notEqual(seedSide[0], seedSide[1], "and the two are different digests");
  });
});
