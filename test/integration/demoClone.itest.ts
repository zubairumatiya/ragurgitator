// THE GUEST CLONE, against a real database (docs/guest-demo-plan.md §1.3).
//
// The clone is the demo's highest-risk piece and the one nothing else can check:
// it is ~200 lines of generated SQL running as a role that bypasses RLS, across
// two tenants, and every one of its failure modes is SILENT. A missed id remap
// does not error — it points the guest's chunk at the seed's document, and both
// rows exist. A stale fingerprint does not error — it makes every pre-warmed
// answer unreachable and the demo degrades to "no answer key" on every question,
// which looks like the LLM key being absent rather than like a broken clone.
//
// So the assertions here are deliberately about ISOLATION and REACHABILITY
// rather than about row counts:
//
//   1. every cloned row points at the guest's copy of its parent, never the
//      seed's — walked one join at a time;
//   2. the guest's banked answer is reachable through the REAL lookup path,
//      which is the only way to prove step 6's fingerprint rewrite landed;
//   3. the seed is untouched, and RLS still separates the two.
//
// The one thing this file cannot check is the egress claim — that no row body
// crosses the wire — because a local Postgres bills nothing. That property is
// enforced by reading lib/demo/clone.ts, where every statement is an
// insert-select and the only values returned are ids, counts and an md5.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import { cloneSeedWorkspace } from "../../lib/demo/clone";
import { forgetMatrix, readMatrix, writeMatrix, writeTuning } from "../../lib/demo/replay";
import {
  packEmbedding,
  packMatrix,
  pairIdentity,
  type ReplayPair,
  type ReplayTuning,
} from "../../lib/demo/replayCore";
import {
  PAIR_BANK_CAP,
  PAIR_BLANK_CAP,
  PAIR_VISIBLE_CAP,
  SHADOW_QUEUE_CAP,
} from "../../lib/demo/frozen";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import {
  PUBLISHED_SWEEP_FINGERPRINT,
  forgetPublishedSweep,
  readPublishedSweep,
} from "../../lib/rag/publishedSweep";
import {
  listPublishedReplays,
  PUBLISHED_REPLAY_FINGERPRINT,
  replayConfig,
} from "../../lib/rag/replayStore";
import { chunksTable, modelDimension, vectorLiteral } from "../../lib/rag/vectorStore";
import type { CachedResult } from "../../lib/rag/semanticCache";
import { semanticCacheLookup, semanticCacheStore } from "../../lib/rag/semanticCache";
import { adminClient, createUser, deleteUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const KEY_MODEL = config.semanticCache.keyModel;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// TWO VECTOR WIDTHS, and the split is forced by the schema rather than chosen.
//
// semantic_cache.query_vector is untyped real[] (embedding_cache.embedding became
// pgvector in 0084),
// so the cache path can use four readable dimensions exactly as
// semanticCache.itest.ts does — and no provider is ever called, because
// embedQueryCached finds the seeded row first.
//
// The chunks table cannot: its column is vector(1024), declared by that model's
// own migration, so a chunk needs a real-width vector. The clone never looks at
// a vector's CONTENTS — it copies the column — so the value is arbitrary and
// only the width matters.
const V = [1, 0, 0, 0];
const DIM = modelDimension(KEY_MODEL);
const CHUNKS = chunksTable(KEY_MODEL, DIM);
const CHUNK_VECTOR = vectorLiteral(Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)));

let admin: Sql;
let seed: { id: string; email: string };
let guest: { id: string; email: string };
let seedConfigId: string;
let seedLabelId: string;

const RESULT = (answer: string): CachedResult => ({
  answer,
  sources: [],
  model: "test-llm",
  efficacy: null,
  escalated: false,
});

async function seedEmbedding(userId: string, text: string) {
  await admin`
    insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
    values (${userId}, ${KEY_MODEL}, 'query', ${sha256(text)}, ${V.length},
            ${`{${V.join(",")}}`}::real[])
    on conflict do nothing`;
}

async function inScope<T>(
  user: { id: string; email: string },
  configId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withUser(user, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
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

// A miniature but STRUCTURALLY COMPLETE seed workspace: every table the clone
// touches, and every foreign key it has to repoint. Small enough to assert on
// exactly, which is why the counts below are literals rather than derived.
beforeEach(async () => {
  await truncateAll(admin);
  // The replay matrix is memoed per process and per user (lib/demo/replay), on
  // the argument that no request path writes it. A truncate IS a write, and the
  // only one that argument does not cover.
  forgetMatrix();
  seed = await createUser(admin);
  guest = await createUser(admin);

  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('seed corpus', ${seed.id}) returning id`;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('a.txt', ${sha256("a")}, 'the body', ${seed.id}) returning id`;
  await admin`
    insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${doc.id})`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${seed.id}, ${corpus.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  seedConfigId = cfg.id;

  const [run] = await admin<{ id: string }[]>`
    insert into document_embeddings
      (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
    values (${doc.id}, ${KEY_MODEL}, ${DIM}, 500, 50, 2, ${cfg.id}) returning id`;
  const chunks = await admin<{ id: string }[]>`
    insert into ${admin(CHUNKS)}
      (document_id, document_embedding_id, position, text, embedding, config_id)
    values
      (${doc.id}, ${run.id}, 0, 'chunk zero', ${CHUNK_VECTOR}, ${cfg.id}),
      (${doc.id}, ${run.id}, 1, 'chunk one',  ${CHUNK_VECTOR}, ${cfg.id})
    returning id`;

  const [q] = await admin<{ id: string }[]>`
    insert into eval_questions (document_id, question) values (${doc.id}, 'what?') returning id`;
  await admin`
    insert into eval_labels (eval_question_id, document_embedding_id, source_chunk_id)
    values (${q.id}, ${run.id}, ${chunks[0].id})`;
  await admin`
    insert into eval_question_embeddings (eval_question_id, model, embedding)
    values (${q.id}, ${KEY_MODEL}, ${`{${V.join(",")}}`})`;

  // A question with NO label under this config — the shape the master carries 82
  // of. It must not reach the guest: nothing can ever score it there.
  await admin`
    insert into eval_questions (document_id, question) values (${doc.id}, 'unlabeled?')`;

  const [label] = await admin<{ id: string }[]>`
    select id from eval_labels where eval_question_id = ${q.id}`;
  seedLabelId = label.id;

  // Three results for the one label, and only ONE of them belongs in a guest:
  //   - the newest 'baseline' row, which is what an override-free config serves;
  //   - an older 'baseline' row, which the per-(label, k) dedupe must drop;
  //   - a row from a TUNED state, which the guest cannot reproduce at all.
  // retrieved_ids is deliberately out of chunk order so a remap that loses the
  // ranking shows up as a reordered array rather than as nothing.
  await admin`
    insert into eval_results
      (eval_question_id, eval_label_id, k, hit, found_rank, retrieved_ids, retrieval_state, scored_at)
    values
      (${q.id}, ${label.id}, 5, true, 2,
       ${[chunks[1].id, chunks[0].id]}::uuid[], 'baseline', '2026-01-02'),
      (${q.id}, ${label.id}, 5, false, null,
       ${[chunks[0].id]}::uuid[], 'baseline', '2026-01-01'),
      (${q.id}, ${label.id}, 5, true, 1,
       ${[chunks[0].id, chunks[1].id]}::uuid[], 'tuned-fingerprint', '2026-01-03')`;

  // The graded-nDCG ground truth (phase 3). chunk_ids is deliberately in the
  // OPPOSITE order to the chunk table so a remap that drops the ordering shows up,
  // and details.perModelRanks is keyed by chunk id — the shape that silently stops
  // rendering if the keys are left in the seed's id space.
  await admin`
    insert into eval_rankings
      (eval_question_id, document_embedding_id, kind, is_truth, chunk_ids, details)
    values (${q.id}, ${run.id}, 'aggregate', true,
            ${[chunks[1].id, chunks[0].id]}::uuid[],
            ${admin.json({
              models: [KEY_MODEL],
              perModelRanks: {
                [chunks[1].id]: { [KEY_MODEL]: 1 },
                [chunks[0].id]: { [KEY_MODEL]: 2 },
              },
            })})`;
  // A non-truth alternative: a candidate in the master's panel, and not the thing
  // nDCG grades against. It must not reach the guest.
  await admin`
    insert into eval_rankings
      (eval_question_id, document_embedding_id, kind, is_truth, chunk_ids, details)
    values (${q.id}, ${run.id}, 'manual', false, ${[chunks[0].id]}::uuid[], '{}')`;

  await admin`
    insert into eval_runs
      (config_id, model, chunk_size, chunk_overlap, k, question_count, hit_count, mrr, ndcg)
    values (${cfg.id}, ${KEY_MODEL}, 500, 50, 5, 1, 1, 0.5, null)`;
  await admin`
    insert into semantic_cache_thresholds (space, threshold, user_id)
    values ('test-space', 0.9, ${seed.id})`;

  // Banked through the REAL store path so the row carries the fingerprint the
  // lookup will compute. Building it by hand would mean reimplementing
  // currentFingerprint in the test, i.e. testing it against itself.
  await seedEmbedding(seed.id, "the banked question");
  await inScope(seed, seedConfigId, () =>
    semanticCacheStore("the banked question", { model: KEY_MODEL, vector: V }, RESULT("banked")),
  );
});

describe("cloneSeedWorkspace", () => {
  it("copies the workspace and repoints every foreign key at the guest's own rows", async () => {
    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    assert.equal(summary.corpora, 1);
    assert.equal(summary.documents, 1);
    assert.equal(summary.configs, 1);
    assert.equal(summary.chunks, 2);
    assert.equal(summary.questions, 1, "the unlabeled question came along");
    assert.equal(summary.results, 1, "the baseline generation is not exactly one row");
    assert.equal(summary.runs, 1);
    assert.equal(summary.rankings, 1, "the non-truth alternative came along");
    assert.equal(summary.cachedAnswers, 1);

    // THE ISOLATION WALK. Each row is fetched by the guest's ownership and its
    // parent id compared against the guest's copy — so a remap that silently
    // fell through to the seed's id fails here rather than in production.
    const [gDoc] = await admin<{ id: string }[]>`
      select id from documents where user_id = ${guest.id}`;
    const [gCfg] = await admin<{ id: string; corpus_id: string }[]>`
      select id, corpus_id from configs where user_id = ${guest.id}`;
    const [gCorpus] = await admin<{ id: string }[]>`
      select id from corpora where user_id = ${guest.id}`;

    assert.notEqual(gDoc.id, undefined);
    assert.equal(gCfg.corpus_id, gCorpus.id, "config points at the seed's corpus");

    const [link] = await admin<{ corpus_id: string; document_id: string }[]>`
      select corpus_id, document_id from corpus_documents
       where corpus_id = ${gCorpus.id}`;
    assert.equal(link.document_id, gDoc.id, "corpus_documents points at the seed's document");

    const [gRun] = await admin<{ id: string; document_id: string; config_id: string }[]>`
      select id, document_id, config_id from document_embeddings where config_id = ${gCfg.id}`;
    assert.equal(gRun.document_id, gDoc.id, "embedding run points at the seed's document");

    const gChunks = await admin.unsafe<
      { id: string; document_id: string; document_embedding_id: string }[]
    >(
      `select id, document_id, document_embedding_id from "${CHUNKS}"
        where config_id = $1 order by position`,
      [gCfg.id],
    );
    assert.equal(gChunks.length, 2);
    for (const c of gChunks) {
      assert.equal(c.document_id, gDoc.id, "chunk points at the seed's document");
      assert.equal(c.document_embedding_id, gRun.id, "chunk points at the seed's embedding run");
    }

    const [gQ] = await admin<{ id: string; document_id: string }[]>`
      select q.id, q.document_id from eval_questions q
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;
    assert.equal(gQ.document_id, gDoc.id);

    // source_chunk_id is a BARE uuid with no foreign key (the chunks table varies
    // per model), so nothing but this assertion would notice it still pointing at
    // the seed's chunk — the row would insert cleanly and the label would grade
    // against another tenant's text.
    const [gLabel] = await admin<{ source_chunk_id: string; document_embedding_id: string }[]>`
      select source_chunk_id, document_embedding_id from eval_labels
       where eval_question_id = ${gQ.id}`;
    assert.equal(gLabel.document_embedding_id, gRun.id);
    assert.ok(
      gChunks.some((c) => c.id === gLabel.source_chunk_id),
      "eval label still points at the SEED's chunk",
    );
  });

  it("leaves the seed account exactly as it was", async () => {
    const before = await admin<{ n: string }[]>`
      select count(*)::text as n from documents where user_id = ${seed.id}`;
    await cloneSeedWorkspace(seed.id, guest.id);
    const after = await admin<{ n: string }[]>`
      select count(*)::text as n from documents where user_id = ${seed.id}`;
    assert.equal(after[0].n, before[0].n);

    // The seed's own config still points at the seed's corpus — i.e. the clone
    // wrote new rows rather than moving existing ones.
    const [sCfg] = await admin<{ corpus_id: string }[]>`
      select corpus_id from configs where user_id = ${seed.id}`;
    const [sCorpus] = await admin<{ id: string }[]>`
      select id from corpora where user_id = ${seed.id}`;
    assert.equal(sCfg.corpus_id, sCorpus.id);
  });

  // THE ONE THAT MATTERS MOST. Step 6 recomputes the document signature over the
  // guest's rows and stamps it on the guest's cache rows; without it the
  // fingerprint in the where-clause matches nothing and every pre-warmed answer
  // is unreachable. A count of cloned rows cannot see that — only the real
  // lookup can.
  it("makes the cloned answer reachable through the real lookup", async () => {
    const { configId } = await cloneSeedWorkspace(seed.id, guest.id);
    await seedEmbedding(guest.id, "the banked question");

    const probe = await inScope(guest, configId, () =>
      semanticCacheLookup("the banked question", {
        serve: true,
        threshold: 0.95,
        keyModel: null,
      }),
    );

    assert.equal(probe.hit, true, "the guest cannot reach their own cloned answer");
    assert.equal(probe.hit && probe.result.answer, "banked");
  });

  it("gives the guest a fingerprint of their OWN documents, not the seed's", async () => {
    await cloneSeedWorkspace(seed.id, guest.id);
    const rows = await admin<{ user_id: string; fingerprint: string }[]>`
      select user_id, fingerprint from semantic_cache order by user_id`;
    assert.equal(rows.length, 2);
    // Different document ids on each side ⇒ different signatures. Equal
    // fingerprints would mean the rewrite never ran, and the previous test would
    // then be passing for the wrong reason (a seed and a guest that happen to
    // share a key).
    assert.notEqual(
      rows[0].fingerprint,
      rows[1].fingerprint,
      "the guest inherited the seed's fingerprint — step 6 did not run",
    );
  });
});

// THE PUBLISH OPTIONS — the snapshot path (docs/demo-snapshot-plan.md), which is
// the same copy with two flags on it. Both flags fail SILENTLY in the same way
// the clone does: an unfiltered publish looks like a working demo that happens to
// show visitors the master's scratch tabs, and an appending republish looks like
// a working demo carrying two of everything until the storage cap bites.
// THE PUBLISHED SCORES (docs/demo-analytics-plan.md, phase 2). Without these the
// demo's Eval tab is a dashboard with its instruments removed — 554 questions all
// reading as unscored, under three refusal messages telling the visitor to go look
// at results that were never cloned.
//
// Two of the copies here are the kind that fail SILENTLY rather than loudly, which
// is why they get assertions of their own: an eval_label_id left pointing at the
// master's row is invisible to the guest's RLS and simply scores nothing, and an
// unremapped retrieved_ids array resolves to no chunks and renders an empty top-k
// under a hit badge claiming rank 2.
describe("cloneSeedWorkspace published scores", () => {
  it("copies the baseline generation, repointed at the guest's own label and chunks", async () => {
    await cloneSeedWorkspace(seed.id, guest.id);

    const [gQ] = await admin<{ id: string }[]>`
      select q.id from eval_questions q
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;
    const [gLabel] = await admin<{ id: string }[]>`
      select id from eval_labels where eval_question_id = ${gQ.id}`;
    assert.notEqual(gLabel.id, seedLabelId, "the guest's label is the seed's row");

    const rows = await admin<
      { eval_label_id: string; found_rank: number; retrieved_ids: string[]; retrieval_state: string }[]
    >`
      select eval_label_id, found_rank, retrieved_ids, retrieval_state
        from eval_results where eval_question_id = ${gQ.id}`;
    assert.equal(rows.length, 1, "the tuned row or the superseded baseline row came along");
    assert.equal(rows[0].retrieval_state, "baseline");
    assert.equal(rows[0].found_rank, 2, "the newest baseline row is not the one that survived");
    assert.equal(rows[0].eval_label_id, gLabel.id, "the result still points at the SEED's label");

    // Rank IS position here, so the assertion is on the ORDER, not the set.
    const gChunks = await admin<{ id: string; position: number }[]>`
      select c.id, c.position from ${admin(CHUNKS)} c
        join documents d on d.id = c.document_id
       where d.user_id = ${guest.id} order by c.position`;
    assert.deepEqual(
      rows[0].retrieved_ids,
      [gChunks[1].id, gChunks[0].id],
      "retrieved_ids lost its ranking or still points at the seed's chunks",
    );
  });

  it("copies the run snapshots behind the As-published card", async () => {
    await cloneSeedWorkspace(seed.id, guest.id);

    const [gCfg] = await admin<{ id: string }[]>`
      select id from configs where user_id = ${guest.id}`;
    const runs = await admin<{ config_id: string; hit_count: number }[]>`
      select config_id, hit_count from eval_runs where config_id = ${gCfg.id}`;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].hit_count, 1);
  });

  it("leaves behind a question nothing in the guest's workspace could ever score", async () => {
    await cloneSeedWorkspace(seed.id, guest.id);

    const qs = await admin<{ question: string }[]>`
      select q.question from eval_questions q
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;
    assert.deepEqual(
      qs.map((r) => r.question),
      ["what?"],
      "a question with no label under the published config reached the guest",
    );
  });

  it("copies the truth ranking into the guest's own id space, order intact", async () => {
    await cloneSeedWorkspace(seed.id, guest.id);

    const gChunks = await admin<{ id: string; position: number }[]>`
      select c.id, c.position from ${admin(CHUNKS)} c
        join documents d on d.id = c.document_id
       where d.user_id = ${guest.id} order by c.position`;
    const [gRanking] = await admin<
      { chunk_ids: string[]; details: { perModelRanks: Record<string, unknown> } }[]
    >`
      select rk.chunk_ids, rk.details from eval_rankings rk
        join eval_questions q on q.id = rk.eval_question_id
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;

    // The ideal order is position 1 then position 0 — the reverse of the chunk
    // table, so a remap that silently returned the rows in table order fails here.
    assert.deepEqual(
      gRanking.chunk_ids,
      [gChunks[1].id, gChunks[0].id],
      "the ideal order did not survive the id remap",
    );
    // Keyed by the GUEST's chunk ids. Left in the seed's space every lookup in the
    // drilldown misses and the per-model annotation just stops appearing — no
    // error, no symptom, an emptier panel.
    assert.deepEqual(
      Object.keys(gRanking.details.perModelRanks).sort(),
      [gChunks[0].id, gChunks[1].id].sort(),
      "perModelRanks is still keyed by the seed's chunk ids",
    );
  });

  it("copies only the ground truth, not the panel's other candidates", async () => {
    await cloneSeedWorkspace(seed.id, guest.id);

    const kinds = await admin<{ kind: string; is_truth: boolean }[]>`
      select rk.kind, rk.is_truth from eval_rankings rk
        join eval_questions q on q.id = rk.eval_question_id
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;
    assert.deepEqual(
      kinds.map((r) => `${r.kind}${r.is_truth ? " (truth)" : ""}`),
      ["aggregate (truth)"],
    );
  });

  it("grades nobody when the publisher selected nobody", async () => {
    // [] and undefined are opposite instructions: a publish whose selection query
    // returned nothing must publish nothing, not quietly fall back to all of them.
    const summary = await cloneSeedWorkspace(seed.id, guest.id, {
      tunableQuestionIds: [],
    });
    assert.equal(summary.rankings, 0);
  });
});

// THE FROZEN SET (docs/demo-analytics-plan.md, phase 4).
//
// What these assert is a SPEND LIMIT, not a feature. A guest's re-score and
// autotune are ungated precisely because ~460 of the 472 questions carry a
// `demo_frozen` ignore and evalStore's scoring queries skip them. Every failure
// mode here is silent in the expensive direction: freeze nothing and the demo
// still works, still looks right, and hands each visitor a button that retrieves
// 472 questions' worth of chunk text.
describe("cloneSeedWorkspace frozen set", () => {
  // A second labeled question, so "the complement" is a set with something in it.
  // The base fixture has exactly one, and a complement of nothing cannot tell a
  // working exclusion apart from a broken one.
  async function secondLabeledQuestion(): Promise<string> {
    const [doc] = await admin<{ id: string }[]>`
      select id from documents where user_id = ${seed.id} and file_name = 'a.txt'`;
    const [run] = await admin<{ id: string }[]>`
      select id from document_embeddings where config_id = ${seedConfigId}`;
    const [chunk] = await admin<{ id: string }[]>`
      select id from ${admin(CHUNKS)} where config_id = ${seedConfigId} order by position`;
    const [q2] = await admin<{ id: string }[]>`
      insert into eval_questions (document_id, question)
      values (${doc.id}, 'and the other one?') returning id`;
    await admin`
      insert into eval_labels (eval_question_id, document_embedding_id, source_chunk_id)
      values (${q2.id}, ${run.id}, ${chunk.id})`;
    return q2.id;
  }

  const guestFrozen = () =>
    admin<{ question: string; reason: string }[]>`
      select q.question, ig.reason
        from config_question_ignores ig
        join eval_questions q on q.id = ig.eval_question_id
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}
       order by q.question`;

  it("freezes every published question except the ones selected", async () => {
    const tunable = await admin<{ id: string }[]>`
      select id from eval_questions where question = 'what?'`;
    await secondLabeledQuestion();

    const summary = await cloneSeedWorkspace(seed.id, guest.id, {
      onlyConfigId: seedConfigId,
      tunableQuestionIds: [tunable[0].id],
    });

    assert.equal(summary.frozen, 1, "the complement of the selection was not frozen");
    assert.deepEqual(
      (await guestFrozen()).map((r) => `${r.question} (${r.reason})`),
      ["and the other one? (demo_frozen)"],
      "the wrong question was frozen, or the reason is not the one the store filters on",
    );
  });

  it("resolves the selection through the id map, not by raw id", async () => {
    // THE SILENT DIRECTION. The publisher passes the MASTER's question ids and the
    // clone has just minted new ones; a comparison that forgot the map would match
    // nothing, freeze everything, and report a healthy-looking count — a demo
    // whose autotune button has no candidates at all, shipped without an error.
    const [tunable] = await admin<{ id: string }[]>`
      select id from eval_questions where question = 'what?'`;
    await secondLabeledQuestion();

    await cloneSeedWorkspace(seed.id, guest.id, {
      onlyConfigId: seedConfigId,
      tunableQuestionIds: [tunable.id],
    });

    const frozen = await guestFrozen();
    assert.equal(frozen.length, 1, "every question froze — the selection did not map");
    assert.notEqual(frozen[0].question, "what?", "the selected question was frozen");
  });

  it("freezes the whole bank when the publisher selected nobody", async () => {
    // The mirror of "grades nobody when the publisher selected nobody": [] is an
    // empty SELECTION, and since the frozen set is its complement, [] must freeze
    // everything rather than — the dangerous reading — freezing nothing.
    await secondLabeledQuestion();

    const summary = await cloneSeedWorkspace(seed.id, guest.id, {
      onlyConfigId: seedConfigId,
      tunableQuestionIds: [],
    });

    assert.equal(summary.frozen, 2);
  });

  it("copies the snapshot's frozen rows on the guest hop, remapped", async () => {
    // The publish hop SYNTHESISES the frozen set; the guest hop COPIES it. This is
    // the second half, and the thing it proves is the repoint: an ignore row left
    // pointing at the snapshot's question id is invisible to the guest's config,
    // so the scope silently evaporates for every visitor.
    const q2 = await secondLabeledQuestion();
    await admin`
      insert into config_question_ignores (config_id, eval_question_id, reason)
      values (${seedConfigId}, ${q2}, 'demo_frozen')`;

    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    assert.equal(summary.frozen, 1);
    const [row] = await admin<{ question: string; config_id: string }[]>`
      select q.question, ig.config_id
        from config_question_ignores ig
        join eval_questions q on q.id = ig.eval_question_id
        join documents d on d.id = q.document_id
       where d.user_id = ${guest.id}`;
    assert.equal(row.question, "and the other one?");
    assert.notEqual(row.config_id, seedConfigId, "the ignore still points at the seed's config");
  });
});

describe("cloneSeedWorkspace publish options", () => {
  // A second tab with its own ingested document, plus a document sitting in the
  // library with no vectors anywhere — the two shapes the filter has to drop, and
  // the second is the one a copy-by-owner cannot tell from corpus content.
  async function widenTheMaster() {
    const [other] = await admin<{ id: string }[]>`
      insert into documents (file_name, content_hash, content, user_id)
      values ('b.txt', ${sha256("b")}, 'other body', ${seed.id}) returning id`;
    const [orphan] = await admin<{ id: string }[]>`
      insert into documents (file_name, content_hash, content, user_id)
      values ('never-ingested.pdf', ${sha256("c")}, 'off topic', ${seed.id}) returning id`;
    const [cfg] = await admin<{ id: string }[]>`
      insert into configs (user_id, base_model, chunk_size, chunk_overlap, top_k, llm_model, tab_order)
      values (${seed.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm', 1) returning id`;
    const [run] = await admin<{ id: string }[]>`
      insert into document_embeddings
        (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
      values (${other.id}, ${KEY_MODEL}, ${DIM}, 500, 50, 1, ${cfg.id}) returning id`;
    await admin.unsafe(
      `insert into "${CHUNKS}" (document_id, document_embedding_id, position, text, embedding, config_id)
       values ($1, $2, 0, 'other chunk', $3, $4)`,
      [other.id, run.id, CHUNK_VECTOR, cfg.id],
    );
    await admin`
      insert into eval_questions (document_id, question) values (${other.id}, 'other?')`;
    return { otherConfigId: cfg.id, orphanId: orphan.id };
  }

  it("publishes one config and only the documents with chunks in it", async () => {
    await widenTheMaster();

    const summary = await cloneSeedWorkspace(seed.id, guest.id, { onlyConfigId: seedConfigId });

    assert.equal(summary.configs, 1, "the other tab came along");
    assert.equal(summary.documents, 1, "a document outside the published config came along");
    assert.equal(summary.chunks, 2);
    assert.equal(summary.questions, 1, "the other tab's question bank came along");

    const names = await admin<{ file_name: string }[]>`
      select file_name from documents where user_id = ${guest.id}`;
    assert.deepEqual(
      names.map((r) => r.file_name),
      ["a.txt"],
      "the guest's library is not exactly the published corpus",
    );

    // The banked answer belongs to the published config, so it must survive the
    // filter — and reach through the fingerprint rewrite, which now runs over a
    // document set narrower than the master's.
    await seedEmbedding(guest.id, "the banked question");
    const probe = await inScope(guest, summary.configId, () =>
      semanticCacheLookup("the banked question", { serve: true, threshold: 0.95, keyModel: null }),
    );
    assert.equal(probe.hit, true, "a filtered publish lost its answer key");
  });

  it("refuses a config the master does not own", async () => {
    const stranger = await createUser(admin);
    const [theirs] = await admin<{ id: string }[]>`
      insert into configs (user_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
      values (${stranger.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;

    await assert.rejects(
      () => cloneSeedWorkspace(seed.id, guest.id, { onlyConfigId: theirs.id }),
      /is not owned by/,
    );
  });

  it("republishes in place instead of stacking a second copy", async () => {
    const first = await cloneSeedWorkspace(seed.id, guest.id, {
      onlyConfigId: seedConfigId,
      replaceDestination: true,
    });
    const second = await cloneSeedWorkspace(seed.id, guest.id, {
      onlyConfigId: seedConfigId,
      replaceDestination: true,
    });
    assert.deepEqual({ ...second, configId: null }, { ...first, configId: null });

    const [counts] = await admin<{ configs: number; documents: number; cached: number }[]>`
      select (select count(*) from configs where user_id = ${guest.id})::int as configs,
             (select count(*) from documents where user_id = ${guest.id})::int as documents,
             (select count(*) from semantic_cache where user_id = ${guest.id})::int as cached`;
    assert.deepEqual(counts, { configs: 1, documents: 1, cached: 1 });

    // semantic_cache.config_id is ON DELETE SET NULL where every other child of
    // `configs` cascades, so a republish that only dropped the configs would leave
    // the previous build's answers behind as unreachable, un-fingerprintable rows
    // — invisible to every count above except this one.
    const [{ n: orphans }] = await admin<{ n: number }[]>`
      select count(*)::int as n from semantic_cache
       where user_id = ${guest.id} and config_id is null`;
    assert.equal(orphans, 0, "the previous build left orphaned cache rows behind");

    // And the surviving copy is reachable: the rewrite ran against the rows that
    // exist now, not the ones the first publish minted.
    await seedEmbedding(guest.id, "the banked question");
    const probe = await inScope(guest, second.configId, () =>
      semanticCacheLookup("the banked question", { serve: true, threshold: 0.95, keyModel: null }),
    );
    assert.equal(probe.hit, true, "the republished answer key is unreachable");
  });

  // THE COLLISION STEP 6 CREATES. Answers banked before and after the corpus
  // changed carry DIFFERENT fingerprints in the seed, which is why they coexist
  // there. The rewrite collapses them onto one fingerprint in the destination,
  // and 0058's unique (user_id, embedding_model, llm_model, fingerprint,
  // query_hash) then rejects the entire insert — so one edited document is
  // enough to make every clone from that account fail, provisioning included.
  //
  // Found the hard way: the first real publish died here with 100 collisions
  // against a seed whose corpus had been edited mid-week.
  it("keeps the newest answer when a fingerprint rewrite collapses two rows onto one key", async () => {
    // The row banked in beforeEach, aged and stamped with a stale signature —
    // exactly the shape a pre-edit answer has. Rewriting the fingerprint by hand
    // is the point here (the collision is about two of them existing), unlike the
    // reachability tests above, which must use the real fingerprint path.
    await admin`
      update semantic_cache
         set fingerprint = 'stale-signature', created_at = now() - interval '1 day'
       where user_id = ${seed.id}`;
    await inScope(seed, seedConfigId, () =>
      semanticCacheStore("the banked question", { model: KEY_MODEL, vector: V }, RESULT("newer")),
    );
    const [{ n: before }] = await admin<{ n: number }[]>`
      select count(*)::int as n from semantic_cache where user_id = ${seed.id}`;
    assert.equal(before, 2, "fixture did not produce two rows to collide");

    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    assert.equal(summary.cachedAnswers, 1, "the colliding row was not deduped");

    // Newest wins, because that is the row the lookup would have served: the
    // index is (…, created_at desc). Serving the older answer would be a silent
    // regression the count above cannot see.
    const [kept] = await admin<{ answer: string }[]>`
      select result->>'answer' as answer from semantic_cache where user_id = ${guest.id}`;
    assert.equal(kept.answer, "newer", "dedupe kept the stale answer");

    // The seed still has both: dedupe is a property of the COPY, not a cleanup
    // of the account being published.
    const [{ n: after }] = await admin<{ n: number }[]>`
      select count(*)::int as n from semantic_cache where user_id = ${seed.id}`;
    assert.equal(after, 2, "the clone mutated the seed's cache");
  });
});

// --- step 5b: the shadow-log sample -----------------------------------------
//
// The clone's ONLY sampling copy, which makes it the only step whose failure mode
// is a chart that renders but is wrong. Every other step is checked for
// reachability — a row is there or it is not. Here a row being there is not
// enough: the calibration curve IS the accept rate per similarity band, so a
// sample that dropped one verdict, or clustered at one end of the range, would
// produce a plausible-looking curve that is not the operator's.
describe("cloneSeedWorkspace shadow sample", () => {
  const FLOOR = config.semanticCache.shadowLogFloor;

  // 60 probe rows spanning the floor upward with a verdict pattern that changes
  // with similarity (as the real population's does — rejects concentrate low), 20
  // traffic rows, and 6 sub-floor rows that must never travel.
  async function seedShadow() {
    const rows: { origin: string; sim: number; verdict: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const sim = FLOOR + (i / 60) * (0.999 - FLOOR);
      // Reject-heavy at the bottom, accept-heavy at the top.
      rows.push({ origin: "probe", sim, verdict: i < 30 ? "reject" : "accept" });
    }
    for (let i = 0; i < 20; i++) {
      rows.push({ origin: "traffic", sim: FLOOR + (i / 20) * (0.999 - FLOOR), verdict: "accept" });
    }
    for (let i = 0; i < 6; i++) {
      rows.push({ origin: "probe", sim: 0.3 + i * 0.05, verdict: "reject" });
    }
    let n = 0;
    for (const r of rows) {
      const q = `shadow question ${n++}`;
      await admin`
        insert into semantic_cache_shadow
          (config_id, embedding_model, space, fingerprint, new_query, new_query_hash,
           matched_query, served_answer, sim, verdict, judge_source, judge_model,
           judge_reason, judged_at, origin)
        values (${seedConfigId}, ${KEY_MODEL}, 'test-space', 'seed-fingerprint',
                ${q}, ${sha256(q)}, 'the banked question', 'an answer',
                ${r.sim}, ${r.verdict}, 'llm', 'judge-model', 'because', now(),
                ${r.origin})`;
    }
  }

  type Row = {
    origin: string;
    sim: number;
    verdict: string | null;
    judge_source: string | null;
    judge_model: string | null;
    judge_reason: string | null;
    judged_at: Date | null;
    fingerprint: string;
  };

  async function guestShadow(): Promise<Row[]> {
    return admin<Row[]>`
      select s.origin, s.sim::float8 as sim, s.verdict, s.judge_source, s.judge_model,
             s.judge_reason, s.judged_at, s.fingerprint
        from semantic_cache_shadow s
        join configs c on c.id = s.config_id
       where c.user_id = ${guest.id}
       order by s.sim`;
  }

  it("takes a capped, stratified sample and leaves the sub-floor band behind", async () => {
    await seedShadow();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestShadow();

    assert.equal(got.length, summary.shadowEvents, "summary must count what landed");
    // Sub-floor rows change no curve (calibrationCurve drops that band), so they
    // would be pure disk. None may travel.
    assert.equal(got.filter((r) => r.sim < FLOOR).length, 0, "sub-floor rows must not be cloned");

    const probe = got.filter((r) => r.origin === "probe");
    const traffic = got.filter((r) => r.origin === "traffic");
    // Under the cap on both origins, so everything above the floor should have
    // come — the caps are a ceiling, and this fixture sits below it.
    assert.equal(traffic.length, 20, "traffic sample");
    assert.equal(probe.length, 60, "probe sample");

    // BOTH VERDICTS SURVIVE, which is the whole reason the sample is stratified:
    // a probe set with no rejects in it is a flat curve wearing a probe label.
    const judged = probe.filter((r) => r.verdict !== null);
    assert.ok(
      judged.some((r) => r.verdict === "reject"),
      "the probe sample must keep its rejects or the curve has no shape",
    );
    assert.ok(judged.some((r) => r.verdict === "accept"), "…and its accepts");

    // AND THE RANGE SURVIVES. Sampling only the top of the similarity range would
    // still satisfy every assertion above and still produce the wrong chart.
    const sims = probe.map((r) => r.sim);
    assert.ok(Math.min(...sims) < FLOOR + 0.05, "sample must reach the bottom of the band");
    assert.ok(Math.max(...sims) > 0.95, "sample must reach the top of the band");
  });

  it("hands over an unjudged queue with every judge column cleared", async () => {
    await seedShadow();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestShadow();
    const queued = got.filter((r) => r.verdict === null);

    assert.equal(queued.length, SHADOW_QUEUE_CAP, "the queue is capped, and it is stocked");
    assert.equal(summary.shadowQueued, queued.length, "summary must count what landed");
    // A row with a cleared verdict but a leftover judge_model reads as a bug in
    // the judge rather than as a queue entry, and the human queue would render a
    // model's name beside an undecided event.
    for (const r of queued) {
      assert.equal(r.judge_source, null);
      assert.equal(r.judge_model, null);
      assert.equal(r.judge_reason, null);
      assert.equal(r.judged_at, null);
    }
    // Drawn from probe: those are the engineered near-misses, so a verdict is a
    // real judgement call rather than an obvious yes.
    assert.ok(
      queued.every((r) => r.origin === "probe"),
      "queue rows come from the probe population",
    );
    assert.ok(queued.every((r) => r.sim >= FLOOR), "a sub-floor verdict would move no curve");
  });

  // --- phase 4: the queue's verdicts, and which rows earn a place in it -----

  // Bank a matrix on the SEED whose shadow half is exactly the probe rows named,
  // which is what "in the pooled set" means at clone time: `poolPairs` decided
  // this on the master, and a pair it dropped has no cosine here to be moved.
  async function seedMatrixOver(questionNumbers: number[]) {
    const pairs: ReplayPair[] = questionNumbers.map((n) => ({
      hash: pairIdentity(`shadow question ${n}`, "the banked question"),
      label: "same",
      source: "shadow",
      origin: "probe",
      difficulty: null,
      quarantined: false,
    }));
    await withUser(seed, () =>
      writeMatrix(
        seed.id,
        packMatrix({
          models: [KEY_MODEL],
          pairs,
          sims: [pairs.map(() => 0.9)],
          target: 0.9,
          minSamples: 2,
        }),
      ),
    );
  }

  it("banks the verdicts it blanks, pointed at the guest's own rows", async () => {
    await seedShadow();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    const banked = await admin<{ key: string; payload: { verdict: string; judge_model: string } }[]>`
      select key, payload from demo_replay
       where user_id = ${guest.id} and kind = 'shadow_verdict'`;
    assert.equal(banked.length, summary.shadowQueued, "every queued row keeps its answer");
    assert.equal(summary.shadowVerdicts, banked.length, "summary must count what landed");

    // KEYED BY THE GUEST'S ROW, not the seed's — the join back is the whole of
    // phase 4, and a key from the wrong id space would look like a full bank and
    // apply to nothing.
    const queued = await admin<{ id: string }[]>`
      select s.id from semantic_cache_shadow s
       join configs c on c.id = s.config_id
       where c.user_id = ${guest.id} and s.verdict is null`;
    assert.deepEqual(
      banked.map((b) => b.key).sort(),
      queued.map((q) => q.id).sort(),
      "a banked verdict names a row in the destination",
    );
    // And it is the operator's real answer, not a placeholder.
    assert.ok(banked.every((b) => ["accept", "reject"].includes(b.payload.verdict)));
    assert.ok(banked.every((b) => b.payload.judge_model === "judge-model"));
  });

  it("prefers queueing rows a verdict would actually move", async () => {
    await seedShadow();
    // Twelve poolable rows, all of them in the top third of the range — a blind
    // ntile spreads across the whole band and would pick at most a few.
    const poolable = [45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56];
    await seedMatrixOver(poolable);
    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    assert.equal(summary.shadowQueued, SHADOW_QUEUE_CAP);
    assert.equal(summary.shadowPoolable, SHADOW_QUEUE_CAP, "every queued row is poolable");
    const queued = await admin<{ new_query: string }[]>`
      select s.new_query from semantic_cache_shadow s
       join configs c on c.id = s.config_id
       where c.user_id = ${guest.id} and s.verdict is null`;
    assert.deepEqual(
      queued.map((q) => q.new_query).sort(),
      poolable.map((n) => `shadow question ${n}`).sort(),
    );
  });

  it("tops the queue up from the rest rather than shipping a short one", async () => {
    await seedShadow();
    // Only three poolable rows exist, so nine come from the general probe set: a
    // queue with some inert rows in it is a better demo than a queue of three.
    await seedMatrixOver([10, 11, 12]);
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    assert.equal(summary.shadowQueued, SHADOW_QUEUE_CAP, "the cap is still filled");
    assert.equal(summary.shadowPoolable, 3, "and the census says how many of them count");
  });

  it("rewrites the fingerprint, so a guest's own traffic dedupes against the sample", async () => {
    await seedShadow();
    const { configId } = await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestShadow();

    assert.ok(got.length > 0, "fixture produced no rows to check");
    assert.ok(
      got.every((r) => r.fingerprint !== "seed-fingerprint"),
      "the capture-time fingerprint is stale in a guest's id space",
    );
    // The SAME value the answer cache was rewritten to: both key on the config's
    // document signature, so a divergence here means one of the two rewrites is
    // computing over the wrong config.
    const [cached] = await admin<{ fingerprint: string }[]>`
      select fingerprint from semantic_cache
       where user_id = ${guest.id} and config_id = ${configId} limit 1`;
    assert.ok(cached, "no cached answer to compare against");
    assert.ok(
      got.every((r) => r.fingerprint === cached.fingerprint),
      "shadow and answer-cache fingerprints must agree",
    );
  });

  it("leaves the seed's shadow log untouched", async () => {
    await seedShadow();
    await cloneSeedWorkspace(seed.id, guest.id);
    const [{ n }] = await admin<{ n: number }[]>`
      select count(*)::int as n from semantic_cache_shadow where config_id = ${seedConfigId}`;
    assert.equal(n, 86, "the seed keeps all 86 rows, sub-floor band included");
    const [{ unjudged }] = await admin<{ unjudged: number }[]>`
      select count(*)::int as unjudged from semantic_cache_shadow
       where config_id = ${seedConfigId} and verdict is null`;
    assert.equal(unjudged, 0, "clearing a verdict happens on the COPY, never in place");
  });
});

// PHASE 6.3 — the model comparison a guest cannot compute.
//
// The replay is a COMPUTATION over embedding_cache (92 MB of vectors on the
// master), not a stored measurement, and the clone deliberately leaves that cache
// behind. So the publish carries its RESULT under a sentinel fingerprint, and
// everything below is about the two ways that goes silently wrong: rows arriving
// under a key nobody will ever compute, and rows a later page visit evicts.
describe("cloneSeedWorkspace published replay", () => {
  const MODELS = ["voyage-4-lite", "voyage-4", "voyage-code-3"];

  // One generation for the seed's config under a real-looking md5, with the shape
  // the master actually holds: some models scored, some with no cached vectors at
  // all and therefore unscorable.
  async function seedReplay(fingerprint = "seed-md5") {
    for (const [i, model] of MODELS.entries()) {
      const scored = i < 2;
      await admin`
        insert into replay_metrics
          (fingerprint, config_id, model, questions, corpus_chunks, coverage_chunks,
           recall_at_1, recall_at_3, recall_at_5, recall_at_10, mrr,
           ndcg, ndcg_k, ndcg_leave_one_out)
        values (${fingerprint}, ${seedConfigId}, ${model}, ${scored ? 1 : 0}, 2,
                ${scored ? 2 : 0},
                ${scored ? 1 : null}, ${scored ? 1 : null}, ${scored ? 1 : null},
                ${scored ? 1 : null}, ${scored ? 0.9 - i * 0.1 : null},
                ${scored ? 0.8 : null}, ${scored ? 5 : null}, false)
        on conflict do nothing`;
    }
  }

  type Row = { model: string; fingerprint: string; mrr: string | null };

  async function guestReplay(): Promise<Row[]> {
    return admin<Row[]>`
      select r.model, r.fingerprint, r.mrr
        from replay_metrics r
        join configs c on c.id = r.config_id
       where c.user_id = ${guest.id}
       order by r.model`;
  }

  it("carries every model row under the sentinel fingerprint, unscorable ones included", async () => {
    await seedReplay();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestReplay();

    assert.equal(got.length, MODELS.length, "one row per model");
    assert.equal(summary.replayRows, got.length, "summary must count what landed");
    assert.equal(summary.replayScored, 2, "and must count the SCORED ones separately");
    // The sentinel is the whole reachability story: the seed's md5 hashes its own
    // config id and cache-row count, so a copied one is a key the guest will never
    // compute — rows present, table empty, and nothing erroring.
    assert.ok(
      got.every((r) => r.fingerprint === PUBLISHED_REPLAY_FINGERPRINT),
      "the capture-time fingerprint is unreachable in a guest's id space",
    );
    // An unscorable model travels too. Dropping it would publish a leaderboard of
    // only the models the operator had happened to pay for, with nothing saying so.
    assert.equal(got.filter((r) => r.mrr === null).length, 1, "the uncovered model comes too");
  });

  it("is reachable through the guest's own read path", async () => {
    await seedReplay();
    await cloneSeedWorkspace(seed.id, guest.id);

    // The proof that matters is not "the rows exist" but "the page finds them".
    const reports = await withUser(guest, () => listPublishedReplays());
    assert.equal(reports.length, 1, "one section for the cloned config");
    assert.equal(reports[0].rows.length, MODELS.length);
    assert.equal(reports[0].corpusChunks, 2, "the pool the master scored over");
    assert.equal(reports[0].questions, 1);
    // MRR desc, unscorable last — the same ordering a real account gets, because
    // both paths share sortRows.
    assert.deepEqual(
      reports[0].rows.map((r) => r.model),
      ["voyage-4-lite", "voyage-4", "voyage-code-3"],
    );
    assert.equal(reports[0].rows.at(-1)?.mrr, null);
  });

  it("prefers the published generation when the seed holds two", async () => {
    // The snapshot account is both a destination and the account guests are cloned
    // FROM, so opening /appraise/models there writes a second, unscorable
    // generation beside the published one. A guest must be cloned from the build.
    await seedReplay(PUBLISHED_REPLAY_FINGERPRINT);
    await admin`
      insert into replay_metrics
        (fingerprint, config_id, model, questions, corpus_chunks, coverage_chunks, mrr)
      values ('a-later-page-visit', ${seedConfigId}, ${MODELS[0]}, 0, 2, 0, null)`;

    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestReplay();

    // Both generations collapse to one key under the rewrite, so without the
    // dedupe this would not merely pick the wrong row — it would abort on the
    // primary key and take the whole publish with it.
    assert.equal(got.length, MODELS.length, "one row per model, not one per generation");
    assert.equal(summary.replayScored, 2, "the scored generation won");
    assert.equal(Number(got.find((r) => r.model === MODELS[0])?.mrr), 0.9);
  });

  it("survives a cold replay in the destination account", async () => {
    // THE SILENT EVICTION. writeCached deletes a config's other fingerprints — it
    // is a cache, and stale generations would only grow. But the published rows are
    // a build artifact nobody in this account can recompute, and a cold replay here
    // is not an error: it is a full set of unscorable rows, which is exactly what
    // would replace them.
    await seedReplay();
    const { configId } = await cloneSeedWorkspace(seed.id, guest.id);

    await withUser(guest, () => replayConfig(configId, KEY_MODEL, "cloned", 5));

    const got = await guestReplay();
    const published = got.filter((r) => r.fingerprint === PUBLISHED_REPLAY_FINGERPRINT);
    assert.equal(published.length, MODELS.length, "the published generation must survive");
    assert.equal(published.filter((r) => r.mrr !== null).length, 2, "…with its metrics");
    const reports = await withUser(guest, () => listPublishedReplays());
    assert.equal(reports[0]?.rows.length, MODELS.length, "and still be what the page reads");
  });

  it("leaves the seed's own generation untouched", async () => {
    await seedReplay();
    await cloneSeedWorkspace(seed.id, guest.id);
    const rows = await admin<{ fingerprint: string }[]>`
      select fingerprint from replay_metrics where config_id = ${seedConfigId}`;
    assert.equal(rows.length, MODELS.length);
    assert.ok(
      rows.every((r) => r.fingerprint === "seed-md5"),
      "the rewrite happens on the COPY, never in place — the master keeps a live cache",
    );
  });
});

// THE PUBLISHED CACHE-KEY SWEEP (step 5d) — phase 1 of docs/demo-cache-lab-plan.
//
// Same shape as the replay above and the same two silent failures, but one more
// thing can go wrong here: this row has NO other writer. Nothing in a request
// path creates it and nothing recomputes it, so if the copy misses, a guest's §4
// is dark and every other panel on the page still works — which is precisely the
// state the phase set out to fix, wearing the same appearance.
describe("cloneSeedWorkspace published sweep", () => {
  const MODELS_SWEPT = ["voyage-4-lite", "voyage-4"];

  // A SweepResult reduced to the fields the panel actually reads: two models,
  // each with a curve, since a curve is what the precision slider re-derives from.
  const result = (models: number) => ({
    cancelled: false,
    target: 0.95,
    targetSource: { target: 0.95, source: "config", configId: seedConfigId, configLabel: "seed" },
    minSamples: 2,
    pairs: { total: 6, shadow: 2, generated: 4, same: 3, different: 3 },
    rows: Array.from({ length: models }, (_, i) => ({
      model: MODELS_SWEPT[i],
      space: "voyage",
      dimension: 4,
      provider: "voyage",
      available: true,
      reason: null,
      threshold: 0.9,
      recallAtThreshold: 0.5,
      auc: 0.8,
      precisionAtThreshold: 1,
      pairsScored: 6,
      samePairs: 3,
      differentPairs: 3,
      calibration: {
        recommended: 0.9,
        target: 0.95,
        minSamples: 2,
        totalJudged: 3,
        overallAcceptRate: 0.667,
        totalAccepts: 2,
        coverageAtRecommended: 0.5,
        precisionAtRecommended: 1,
        // PACKED as [sim, n, accepts] — phase 1.5. This is the form
        // writePublishedSweep stores and the form the panel unpacks, so the
        // fixture is written in it rather than in the fuller shape: a fixture
        // that did not match the writer would test a row nothing produces.
        curve: [
          [0.95, 1, 1],
          [0.9, 2, 2],
          [0.4, 3, 2],
        ],
        attainability: {
          blocker: null,
          bestRate: 1,
          bestRateAt: { sim: 0.9, n: 2 },
          coverageAtBest: 1,
          rejectsInBest: 0,
          requiredN: null,
        },
      },
      error: null,
    })),
  });

  async function seedSweep(fingerprint = PUBLISHED_SWEEP_FINGERPRINT, models = 2) {
    await admin`
      insert into published_sweep (config_id, fingerprint, result)
      values (${seedConfigId}, ${fingerprint}, ${admin.json(result(models) as never)})
      on conflict (config_id, fingerprint)
        do update set result = excluded.result, computed_at = now()`;
  }

  it("carries the sweep under the sentinel, remapped to the guest's config", async () => {
    await seedSweep();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    const rows = await admin<{ config_id: string; fingerprint: string }[]>`
      select s.config_id, s.fingerprint
        from published_sweep s
        join configs c on c.id = s.config_id
       where c.user_id = ${guest.id}`;
    assert.equal(rows.length, 1, "one published sweep for the cloned config");
    assert.equal(summary.sweepRows, 1, "the summary must count what landed");
    assert.equal(summary.sweepModels, MODELS_SWEPT.length, "…and the models inside it");
    assert.notEqual(rows[0].config_id, seedConfigId, "remapped to the guest's own config");
    assert.equal(rows[0].fingerprint, PUBLISHED_SWEEP_FINGERPRINT);
  });

  it("is reachable through the guest's own read path", async () => {
    // Rows existing is not the claim. The claim is that the panel finds them —
    // readPublishedSweep addresses them by the sentinel and by ownership, and a
    // sweep the guest cannot read is a §4 that stays dark with the row in place.
    await seedSweep();
    await cloneSeedWorkspace(seed.id, guest.id);

    const got = await withUser(guest, () => readPublishedSweep());
    assert.ok(got, "the guest's panel must find a sweep");
    assert.equal(got.rows.length, MODELS_SWEPT.length);
    assert.equal(got.target, 0.95);
    // The curve is the payload that matters: without it the leaderboard renders
    // and the precision slider still has nothing to re-derive.
    assert.equal(got.rows[0].calibration?.curve.length, 3);
    // And it comes back PACKED, which is what the panel is written against —
    // unpacking on the server would put the bytes packing removed straight back
    // on the wire.
    assert.deepEqual(got.rows[0].calibration?.curve[0], [0.95, 1, 1]);
  });

  it("memoises the read, and lets it be forgotten", async () => {
    // Phase 1.5. The row has NO writer in any request path, so within a guest's
    // life it is immutable and a second read can only return what the first did
    // — which is what makes a per-user memo safe in front of a hop Supabase
    // bills on every panel mount. Deleting the row underneath the memo is how
    // the test tells a cached answer from a fresh query.
    await seedSweep();
    await cloneSeedWorkspace(seed.id, guest.id);
    assert.ok(await withUser(guest, () => readPublishedSweep()), "the first read must find it");

    await admin`
      delete from published_sweep s
        using configs c
       where c.id = s.config_id and c.user_id = ${guest.id}`;
    assert.ok(
      await withUser(guest, () => readPublishedSweep()),
      "the second read must not have gone back to Postgres",
    );

    forgetPublishedSweep(guest.id);
    assert.equal(
      await withUser(guest, () => readPublishedSweep()),
      null,
      "forgetting must put the truth back",
    );
  });

  it("does not memoise a miss, so provisioning can still fill it in", async () => {
    // The one asymmetry: the clone writes the guest's row DURING provisioning,
    // in this same process. "No sweep yet" legitimately changes; "here is the
    // sweep" does not. Caching the miss would be the one way this memo could
    // leave a guest's §4 permanently dark.
    await seedSweep();
    assert.equal(await withUser(guest, () => readPublishedSweep()), null);
    await cloneSeedWorkspace(seed.id, guest.id);
    assert.ok(
      await withUser(guest, () => readPublishedSweep()),
      "a miss cached before provisioning would never be revisited",
    );
  });

  it("prefers the published row when the seed holds another generation", async () => {
    // Both rows collapse onto one primary key under the rewrite, so without the
    // dedupe this does not pick the wrong row — it aborts the whole publish.
    await seedSweep();
    await seedSweep("some-other-generation", 1);

    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    assert.equal(summary.sweepRows, 1, "one row per destination config");
    assert.equal(summary.sweepModels, MODELS_SWEPT.length, "the published generation won");
  });

  it("reports nothing when the seed has no sweep, without failing the publish", async () => {
    // The demo shipped for its whole life in this state, and it must stay a valid
    // build: §4 falls back to the disabled buttons it always had.
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    assert.equal(summary.sweepRows, 0);
    assert.equal(summary.sweepModels, 0);
    assert.equal(await withUser(guest, () => readPublishedSweep()), null);
  });

  it("leaves the seed's own row untouched", async () => {
    await seedSweep();
    await cloneSeedWorkspace(seed.id, guest.id);
    const rows = await admin<{ config_id: string }[]>`
      select config_id from published_sweep where config_id = ${seedConfigId}`;
    assert.equal(rows.length, 1, "the rewrite happens on the COPY, never in place");
  });
});

// THE GENERATED PAIR SET (step 5e) — phases 3 and 3b of docs/demo-cache-lab-plan.
//
// Unlike the sweep above, this copy is WITHHELD in two directions at once: a
// tranche never reaches the pair table at all (demo_pair_bank, kind='pair'), and
// a handful of the rows that do reach it arrive with their verdicts stripped
// (kind='verdict'). Both are reveals of work the publish already paid for, so
// both failure modes are quiet ones — a bank that leaked into the pair table
// would move the panel's counts before the guest pressed anything, and a blanked
// verdict with no bank row behind it would make "Screen pairs" resolve an
// unscreened count to nothing.
describe("cloneSeedWorkspace generated pairs", () => {
  // 100 pairs in three strata, sized so the caps divide them exactly: the whole
  // point of the stride is that each stratum contributes its own share, and a
  // fixture with ragged arithmetic could not tell a preserved mix from a lucky
  // one. created_at is explicit and ascending so the stride is deterministic —
  // ties on created_at would fall through to a random uuid.
  const STRATA = [
    { label: "same", difficulty: "paraphrase", n: 50 },
    { label: "different", difficulty: "hard-negative", n: 40 },
    { label: "different", difficulty: "paraphrase", n: 10 },
  ] as const;

  async function seedPairs() {
    let n = 0;
    for (const stratum of STRATA) {
      for (let i = 0; i < stratum.n; i++) {
        const a = `origin question ${n}`;
        const b = `variant ${n}`;
        // Rejects first inside the hard-negative stratum, then accepts, then a
        // tail of unjudged rows — F3's shape, where the quarantine is the
        // minority and some of the set was never audited at all.
        let verdict: string | null = null;
        if (stratum.difficulty === "hard-negative") {
          verdict = i < 16 ? "reject" : i < 30 ? "accept" : null;
        } else if (stratum.label === "same") {
          verdict = "accept";
        }
        await admin`
          insert into semantic_cache_pairs
            (origin_question_id, text_a, text_b, hash_a, hash_b, label, difficulty,
             generated_by, created_at, verdict, verdict_source, judge_model,
             judge_reason, judged_at)
          select q.id, ${a}, ${b}, ${sha256(a)}, ${sha256(b)},
                 ${stratum.label}, ${stratum.difficulty}, 'test-judge',
                 ${`2026-01-01T00:00:00Z`}::timestamptz + ${n} * interval '1 minute',
                 ${verdict},
                 ${verdict ? "llm" : null},
                 ${verdict ? "judge-model" : null},
                 ${verdict ? `because ${n}` : null},
                 ${verdict ? new Date("2026-02-01T00:00:00Z") : null}
            from eval_questions q
            join documents d on d.id = q.document_id
           where d.user_id = ${seed.id} and q.question = 'what?'`;
        n++;
      }
    }
  }

  type Pair = {
    label: string;
    difficulty: string;
    text_b: string;
    verdict: string | null;
    verdict_source: string | null;
    judge_model: string | null;
    judge_reason: string | null;
    judged_at: Date | null;
  };

  async function guestPairs(userId = guest.id): Promise<Pair[]> {
    return admin<Pair[]>`
      select s.label, s.difficulty, s.text_b, s.verdict, s.verdict_source,
             s.judge_model, s.judge_reason, s.judged_at
        from semantic_cache_pairs s
        join eval_questions q on q.id = s.origin_question_id
        join documents d on d.id = q.document_id
       where d.user_id = ${userId}
       order by s.created_at`;
  }

  type BankRow = { kind: string; pair_id: string | null; payload: Record<string, unknown> };

  async function bank(userId = guest.id): Promise<BankRow[]> {
    return admin<BankRow[]>`
      select kind, pair_id, payload from demo_pair_bank where user_id = ${userId}`;
  }

  it("takes a capped sample that keeps the master's (label, difficulty) mix", async () => {
    await seedPairs();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestPairs();

    assert.equal(got.length, PAIR_VISIBLE_CAP, "the cap is a ceiling and this fixture exceeds it");
    assert.equal(summary.pairRows, got.length, "summary must count what landed");

    // THE MIX IS THE ASSERTION. A flat 60-row cut off the top of the set would
    // satisfy a count check and still hand the guest a pair set whose
    // same:different and paraphrase:hard-negative ratios are not the ones the
    // banked leaderboard was measured on — and hard negatives are the entire
    // discriminating power of the set (0040).
    const count = (label: string, difficulty: string) =>
      got.filter((p) => p.label === label && p.difficulty === difficulty).length;
    const rate = PAIR_VISIBLE_CAP / 100;
    for (const s of STRATA) {
      assert.equal(count(s.label, s.difficulty), s.n * rate, `${s.label}/${s.difficulty} share`);
    }
  });

  it("carries the quarantine — an audited reject keeps its verdict and its reason", async () => {
    await seedPairs();
    await cloneSeedWorkspace(seed.id, guest.id);
    const got = await guestPairs();

    // F3 proved 15 of the master's pairs mislabelled, and the quarantine is what
    // keeps the sweep from consuming them. A clone that dropped the verdict would
    // hand a guest exactly those rows as truth.
    const rejects = got.filter((p) => p.verdict === "reject");
    assert.ok(rejects.length > 0, "the sample must keep rejects or the quarantine is decorative");
    for (const r of rejects) {
      assert.equal(r.verdict_source, "llm");
      assert.ok(r.judge_reason, "the reason is the sentence explaining the quarantine");
      assert.ok(r.judged_at, "a verdict with no judged_at reads as a bug in the judge");
    }
    // The unjudged tail travels as it is: those rows were never audited on the
    // master either, and inventing a verdict for them would be the one thing the
    // screen button must not do.
    assert.ok(got.some((p) => p.verdict === null), "the master's unaudited rows come too");
  });

  it("blanks a slice and stashes its true verdicts, rejects included", async () => {
    await seedPairs();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const rows = await bank();
    const verdicts = rows.filter((r) => r.kind === "verdict");

    assert.equal(verdicts.length, PAIR_BLANK_CAP, "the unscreened slice is capped");
    assert.equal(summary.blankedVerdicts, verdicts.length, "summary must count what landed");
    // At least one reject, so pressing screen actually quarantines something. Safe
    // only because the guest's leaderboard is banked (0077) and never recomputed,
    // so an unjudged reject cannot reach a sweep.
    assert.ok(
      verdicts.some((r) => r.payload.verdict === "reject"),
      "a screen pass that quarantines nothing teaches the wrong thing",
    );

    // EVERY BLANKED ROW HAS ITS ANSWER BEHIND IT. The pair the bank names must be
    // the guest's own, and it must be genuinely unscreened — all five columns, or
    // the panel's count is wrong in the other direction.
    for (const r of verdicts) {
      assert.ok(r.pair_id, "a verdict row with no pair resolves nothing");
      const [pair] = await admin<Pair[]>`
        select s.label, s.difficulty, s.text_b, s.verdict, s.verdict_source,
               s.judge_model, s.judge_reason, s.judged_at
          from semantic_cache_pairs s
          join eval_questions q on q.id = s.origin_question_id
          join documents d on d.id = q.document_id
         where s.id = ${r.pair_id} and d.user_id = ${guest.id}`;
      assert.ok(pair, "the banked verdict must point at a pair the guest owns");
      assert.equal(pair.verdict, null);
      assert.equal(pair.verdict_source, null);
      assert.equal(pair.judge_model, null);
      assert.equal(pair.judge_reason, null);
      assert.equal(pair.judged_at, null);
      assert.ok(r.payload.judge_reason, "…and must hold the reason back, not lose it");
    }
  });

  it("holds the reveal tranche OUT of the pair table", async () => {
    await seedPairs();
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    const rows = await bank();
    const banked = rows.filter((r) => r.kind === "pair");
    const got = await guestPairs();

    assert.equal(banked.length, PAIR_BANK_CAP, "the reveal tranche is capped too");
    assert.equal(summary.bankedPairs, banked.length, "summary must count what landed");

    // If a banked pair were also in the pair table, every reader of that table —
    // pooledPairs, listPairs, the unscreened count — would already be counting a
    // row "Generate pairs" has not handed over, and the slider would move a number
    // that was never wrong.
    const visible = new Set(got.map((p) => p.text_b));
    for (const r of banked) {
      assert.ok(!visible.has(r.payload.text_b as string), "a banked pair is not visible yet");
      // Remapped on the way IN, because the id map is a temp table that dies with
      // the clone's transaction: the master's question id would be a foreign key
      // nobody downstream could resolve.
      const [q] = await admin<{ id: string }[]>`
        select q.id from eval_questions q
          join documents d on d.id = q.document_id
         where d.user_id = ${guest.id} and q.question = 'what?'`;
      assert.equal(r.payload.origin_question_id, q.id, "banked payloads carry the GUEST's question");
      assert.equal(r.payload.id, undefined, "an insertable payload carries no id");
    }
  });

  it("clones a second guest from the same master", async () => {
    // 0050 made the pair key (origin_question_id, hash_a, hash_b) per ORIGIN
    // QUESTION, and every guest gets freshly-minted question ids — so two guests
    // holding the same text pair cannot collide. If they could, the second
    // provisioning of the day would abort with a unique violation and the demo
    // would be a one-visitor demo.
    await seedPairs();
    const first = await cloneSeedWorkspace(seed.id, guest.id);
    const other = await createUser(admin);
    const second = await cloneSeedWorkspace(seed.id, other.id);

    assert.equal(second.pairRows, first.pairRows, "the second guest gets the same publish");
    assert.equal(second.bankedPairs, first.bankedPairs);
    assert.equal(second.blankedVerdicts, first.blankedVerdicts);
    assert.equal((await guestPairs(other.id)).length, PAIR_VISIBLE_CAP);
    assert.equal((await bank(other.id)).length, PAIR_BANK_CAP + PAIR_BLANK_CAP);
    // And neither guest can see the other's bank: it is root-owned by user_id
    // (0078), the one table in this step with no config or question above it.
    assert.equal((await bank()).length, PAIR_BANK_CAP + PAIR_BLANK_CAP);
  });

  it("carries the bank across a SECOND hop, which is the one production runs", async () => {
    // THE HOP THE OTHER TESTS DO NOT MAKE, and the reason phase 3 shipped
    // invisible. Every test above clones master→guest once, which is the hop that
    // works: the master holds 100 pairs, the visible sample takes 60 and the bank
    // tranche takes 20 of the 40 left over.
    //
    // Production never makes that hop. It makes master→SNAPSHOT (demo:snapshot)
    // and then snapshot→guest (every visitor), and the second one has no leftovers
    // to draw on: the snapshot's pair TABLE holds only the 60 that were made
    // visible, its own 20 banked rows living in demo_pair_bank. PAIR_VISIBLE_CAP
    // swallows all 60, `p.banked` matches nothing, and the guest opens with an
    // empty bank — so "Generate pairs" is sized off zero and never renders.
    //
    // This cannot be caught by a one-hop test at any fixture size, because the cap
    // that empties the pool is the same cap that filled it.
    await seedPairs();
    const snapshot = await createUser(admin);
    const published = await cloneSeedWorkspace(seed.id, snapshot.id);
    assert.equal(published.bankedPairs, PAIR_BANK_CAP, "the first hop banks from leftovers");

    const provisioned = await cloneSeedWorkspace(snapshot.id, guest.id);

    assert.equal(
      provisioned.bankedPairs,
      PAIR_BANK_CAP,
      "the second hop must FORWARD the bank, having no leftovers of its own",
    );
    const banked = (await bank()).filter((r) => r.kind === "pair");
    assert.equal(banked.length, PAIR_BANK_CAP, "and the rows must actually land");

    // Forwarded payloads must name the GUEST's questions, not the snapshot's —
    // _map_question dies with each transaction, so a payload that kept the
    // previous hop's id would be a foreign key nobody downstream can resolve.
    const guestQuestions = new Set(
      (
        await admin<{ id: string }[]>`
          select q.id from eval_questions q
            join documents d on d.id = q.document_id
           where d.user_id = ${guest.id}`
      ).map((r) => r.id),
    );
    for (const r of banked) {
      assert.ok(
        guestQuestions.has(r.payload.origin_question_id as string),
        "a forwarded payload must be remapped onto the guest's own question",
      );
    }

    // And the verdicts, for the symptom that hid behind the same cause: each hop
    // blanks a fresh PAIR_BLANK_CAP rows, so without forwarding the guest arrives
    // holding two hops' worth of unscreened pairs and one hop's worth of answers —
    // leaving PAIR_BLANK_CAP of them permanently unscreenable, since the only copy
    // of the audited verdict stayed in the snapshot's bank.
    // BOTH HOPS' WORTH, not one. Deliberately not compared against the guest's
    // total unjudged count: the fixture also carries pairs that were never judged
    // in the first place, and those correctly have no banked answer — only a row
    // whose verdict was CLEARED on the way in is owed one.
    const verdicts = (await bank()).filter((r) => r.kind === "verdict");
    assert.equal(
      verdicts.length,
      PAIR_BLANK_CAP * 2,
      "without forwarding this is PAIR_BLANK_CAP, and the first hop's six are unscreenable forever",
    );
    // Each one must point at a pair the guest actually holds, and at one that is
    // genuinely blanked — a verdict aimed at a row that already has its answer
    // would resolve nothing and inflate the screen's count.
    const blankedIds = new Set(
      (
        await admin<{ id: string }[]>`
          select s.id from semantic_cache_pairs s
            join eval_questions q on q.id = s.origin_question_id
            join documents d on d.id = q.document_id
           where d.user_id = ${guest.id} and s.verdict is null`
      ).map((r) => r.id),
    );
    for (const v of verdicts) {
      assert.ok(
        v.pair_id && blankedIds.has(v.pair_id),
        "a forwarded verdict must name a blanked pair of the guest's own",
      );
    }
  });

  it("leaves the seed's own pair set untouched", async () => {
    await seedPairs();
    await cloneSeedWorkspace(seed.id, guest.id);
    const [{ n, unjudged }] = await admin<{ n: number; unjudged: number }[]>`
      select count(*)::int as n,
             count(*) filter (where s.verdict is null)::int as unjudged
        from semantic_cache_pairs s
        join eval_questions q on q.id = s.origin_question_id
        join documents d on d.id = q.document_id
       where d.user_id = ${seed.id}`;
    assert.equal(n, 100, "the master keeps its whole set");
    // 20 unjudged in the fixture and not one more: blanking happens on the COPY,
    // exactly as the shadow queue's does.
    assert.equal(unjudged, 20, "clearing a verdict never happens in place");
  });
});

// THE SIMILARITY MATRIX (step 5g) — phase 2 of docs/demo-cache-replay-plan.md.
//
// The demo's semantic-cache page replays the master's own arithmetic rather than
// shipping a sample of its inputs, and the matrix is that arithmetic: one cosine
// per pair per candidate model, plus each pair's label and a hash of its two
// texts. Three properties are asserted here and none of them is visible on a
// page that renders:
//
//   1. IT SURVIVES BOTH HOPS. The publish is master → snapshot → guest, and the
//      last banked artifact to cross this seam (demo_pair_bank, phase 3 of the
//      lab plan) shipped INVISIBLE in production for exactly this reason: the
//      first hop worked, the second found nothing to forward, and an itest that
//      clones once could not see it. So this one clones twice.
//   2. A REPUBLISH REPLACES IT. demo_replay hangs off user_profiles alone, so no
//      cascade in step 0's list reaches it, and 0080's primary key would keep the
//      OLD payload on a conflict — the previous build's matrix under the new
//      build's pairs, arriving as a perfectly successful copy.
//   3. THE COUNT IS OUT OF THE PAYLOAD. `matrixPairs` reports pairs, not rows: a
//      matrix over nothing is a leaderboard with nothing to score and it copies
//      just as successfully as a full one.
// THE SAVINGS LEDGER — step 5h, phase 6 of docs/demo-cache-replay-plan.md.
//
// `PayoffReadout` is the only line on the semantic-cache page that quotes money,
// and it derives it from a rate: readCacheEconomics divides `savings_totals`'
// saved_usd by its event_count for lever 'semantic_cache'. With no row the
// quotient is deliberately null rather than 0 — "no hit has been priced" and "a
// hit is worth nothing" are different claims — so the money simply vanishes and
// nothing renders as broken. That is why it is asserted here rather than trusted
// to a page that looks fine either way.
//
// Two properties: the row is REMAPPED onto the destination's config (the reader
// scopes by owned configs, so a row still pointing at the seed's config is a row
// no guest can see), and the copy is SCOPED TO ONE LEVER (money for embedding or
// cascade work the guest's workspace never performed would land on the Costs
// page as a claim about them).
describe("cloneSeedWorkspace savings ledger", () => {
  const bankLever = (lever: string, events: number, usd: string) =>
    admin`
      insert into savings_totals (config_id, lever, event_count, tokens_saved, saved_usd)
      values (${seedConfigId}, ${lever}, ${events}, 0, ${usd})
      on conflict (config_id, lever) do update set event_count = excluded.event_count,
                                                   saved_usd = excluded.saved_usd`;

  const landed = (userId: string) =>
    admin<{ lever: string; event_count: string; saved_usd: string; config_id: string }[]>`
      select s.lever, s.event_count, s.saved_usd, s.config_id
        from savings_totals s join configs c on c.id = s.config_id
       where c.user_id = ${userId} order by s.lever`;

  it("carries the semantic_cache row onto the guest's own config", async () => {
    await bankLever("semantic_cache", 51, "0.200294");
    const summary = await cloneSeedWorkspace(seed.id, guest.id, { onlyConfigId: seedConfigId });

    const rows = await landed(guest.id);
    assert.equal(summary.ledgerRows, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lever, "semantic_cache");
    assert.equal(Number(rows[0].event_count), 51);
    // The dollars travel exactly, because what the readout uses is the quotient
    // and a rounded copy would quote a price the Costs page never printed.
    assert.equal(Number(rows[0].saved_usd), 0.200294);
    assert.notEqual(rows[0].config_id, seedConfigId, "remapped, or no guest can read it");
  });

  it("leaves every other lever behind", async () => {
    await bankLever("semantic_cache", 4, "0.04");
    await bankLever("embed_cache", 900, "12.5");
    await bankLever("cascade", 30, "-0.9");
    const summary = await cloneSeedWorkspace(seed.id, guest.id, { onlyConfigId: seedConfigId });

    assert.equal(summary.ledgerRows, 1);
    assert.deepEqual((await landed(guest.id)).map((r) => r.lever), ["semantic_cache"]);
  });

  it("survives the second hop, master \u2192 snapshot \u2192 guest", async () => {
    await bankLever("semantic_cache", 51, "0.200294");
    await cloneSeedWorkspace(seed.id, guest.id, { onlyConfigId: seedConfigId });

    const second = await createUser(admin);
    const summary = await cloneSeedWorkspace(guest.id, second.id);
    assert.equal(summary.ledgerRows, 1);
    assert.equal(Number((await landed(second.id))[0].saved_usd), 0.200294);
    await deleteUser(admin, second.id);
  });

  it("publishes without one, since a master that has served no hit has no row", async () => {
    const summary = await cloneSeedWorkspace(seed.id, guest.id, { onlyConfigId: seedConfigId });
    assert.equal(summary.ledgerRows, 0);
    assert.equal((await landed(guest.id)).length, 0);
  });
});

describe("cloneSeedWorkspace replay matrix", () => {
  const matrix = (pairs: number, models = ["voyage-4-lite", "voyage-4"]) => ({
    version: 1,
    models,
    pairs: Array.from({ length: pairs }, (_, i) => ({
      hash: `hash-${i}`,
      label: i % 2 === 0 ? "same" : "different",
      source: i < pairs - 1 ? "generated" : "shadow",
      difficulty: i % 2 === 0 ? "paraphrase" : "hard-negative",
      quarantined: false,
    })),
    // A model that did not score is null rather than a row of zeros; the copy
    // must carry that distinction through unchanged.
    sims: [Array.from({ length: pairs }, (_, i) => 0.5 + i / 100), null],
    target: 0.95,
    minSamples: 2,
  });

  async function bankMatrix(userId: string, pairs = 4) {
    await admin`
      insert into demo_replay (user_id, kind, key, payload)
      values (${userId}, 'matrix', 'pooled', ${admin.json(matrix(pairs))})
      on conflict (user_id, kind, key)
        do update set payload = excluded.payload`;
  }

  const banked = (userId: string) =>
    admin<{ kind: string; key: string; payload: Record<string, unknown> }[]>`
      select kind, key, payload from demo_replay where user_id = ${userId} order by kind, key`;

  it("forwards the matrix byte for byte, with no remapping at all", async () => {
    await bankMatrix(seed.id);
    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    const rows = await banked(guest.id);
    assert.equal(rows.length, 1, "one matrix, and nothing else banked yet");
    assert.equal(rows[0].kind, "matrix");
    // The whole payload, not a field of it. A matrix names no row in either
    // account — pairs are identified by a hash of their own text — so unlike
    // every other banked thing the clone carries there is nothing here to
    // rewrite, and any difference at all would be a bug rather than a remap.
    assert.deepEqual(rows[0].payload, matrix(4));
    assert.equal(summary.matrixPairs, 4, "counted out of the payload");
  });

  it("survives the second hop, which is the one that has shipped broken before", async () => {
    await bankMatrix(seed.id);
    await cloneSeedWorkspace(seed.id, guest.id);

    const second = await createUser(admin);
    await cloneSeedWorkspace(guest.id, second.id);

    const rows = await banked(second.id);
    assert.equal(rows.length, 1, "the snapshot forwards what it was given");
    assert.deepEqual(rows[0].payload, matrix(4), "and forwards it unchanged");
    await deleteUser(admin, second.id);
  });

  it("replaces the previous build's matrix on a republish", async () => {
    await bankMatrix(seed.id, 4);
    await cloneSeedWorkspace(seed.id, guest.id, { replaceDestination: true });
    await bankMatrix(seed.id, 7);
    const summary = await cloneSeedWorkspace(seed.id, guest.id, { replaceDestination: true });

    const rows = await banked(guest.id);
    assert.equal(rows.length, 1, "not two, and not the first one kept by the primary key");
    assert.deepEqual(rows[0].payload, matrix(7));
    assert.equal(summary.matrixPairs, 7);
  });

  it("reports nothing when the seed has no matrix, without failing the publish", async () => {
    // Every build published before this phase is in this state, and it must stay
    // a valid one: the page falls back to what it does for a real account.
    const summary = await cloneSeedWorkspace(seed.id, guest.id);
    assert.equal(summary.matrixPairs, 0);
    assert.equal((await banked(guest.id)).length, 0);
  });

  it("carries only the matrix — progress and verdicts belong to the destination", async () => {
    // The visitor's walk into the matrix is theirs, and a forwarded `progress`
    // would open a fresh workspace part-way through someone else's session. The
    // banked verdicts name the destination's own shadow rows, so they are written
    // by the step that mints those rows and cannot be copied by key.
    await bankMatrix(seed.id);
    await admin`
      insert into demo_replay (user_id, kind, key, payload)
      values (${seed.id}, 'progress', 'pairs', ${admin.json({ generated: 3, screened: true })}),
             (${seed.id}, 'shadow_verdict', 'some-shadow-id', ${admin.json({ verdict: "accept" })})`;

    await cloneSeedWorkspace(seed.id, guest.id);
    assert.deepEqual([...(await banked(guest.id))].map((r) => r.kind), ["matrix"]);
  });

  it("is read back only by a guest, so a real account still computes its own", async () => {
    await bankMatrix(seed.id);
    await cloneSeedWorkspace(seed.id, guest.id);

    // The carve-out is the function (lib/demo/replay), which is what lets a route
    // call it unconditionally and still fail closed.
    assert.equal(await withUser(guest, () => readMatrix()), null, "not a guest yet");
    await admin`
      update user_profiles set is_guest = true, expires_at = now() + interval '2 hours'
       where id = ${guest.id}`;
    const read = await withUser(guest, () => readMatrix());
    assert.equal(read?.pairs.length, 4);
    assert.equal(read?.sims[1], null, "an unscored model stays unscored");
  });

  it("leaves the seed's own matrix untouched", async () => {
    await bankMatrix(seed.id);
    await cloneSeedWorkspace(seed.id, guest.id);
    assert.equal((await banked(seed.id)).length, 1);
  });
});

// --- step 5k: the delegate-space vectors ------------------------------------
//
// docs/demo-rescore-replay-plan.md. The one copy in this file whose absence is
// invisible: without it a guest's ⚙ Auto tune still works, still re-scores, and
// still reports real numbers — it just buys 744 embeddings on the operator's key
// and takes three minutes instead of thirty-seven seconds. Nothing errors, so
// only a test that asserts on the COPIED SET can hold the scope in place.
//
// The scope is the whole design, so each assertion below is one way of widening
// or narrowing it wrongly.
describe("cloneSeedWorkspace delegate vectors", () => {
  // Not KEY_MODEL: the config's own base model is excluded on purpose — the
  // fusion lane short-circuits for it, and its vectors live in the chunks table
  // step 3 already copies.
  const DELEGATE = "voyage-code-2";

  async function cacheRow(userId: string, model: string, kind: string, text: string) {
    await admin`
      insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
      values (${userId}, ${model}, ${kind}, ${sha256(text)}, ${V.length}, ${`{${V.join(",")}}`}::real[])
      on conflict do nothing`;
  }

  // A shelf whose one winner delegates to DELEGATE — the only thing that makes
  // the copy happen at all.
  async function bankTuning(model: string) {
    const tuning: ReplayTuning = {
      version: 1,
      entries: [
        {
          chunk: (
            await admin<{ id: string }[]>`select id from ${admin(CHUNKS)} order by position limit 1`
          )[0].id,
          model,
          kind: "model",
          detail: `delegate → ${model}`,
          pieces: [
            { text: null, dimension: 2, embedding: packEmbedding([0.5, -0.25]), tokenStart: null, tokenEnd: null },
          ],
          trials: [],
        },
      ],
    };
    await withUser(seed, () => writeTuning(seed.id, tuning));
  }

  async function copied(): Promise<{ model: string; kind: string; hash: string }[]> {
    const rows = await admin<{ model: string; input_kind: string; text_hash: string }[]>`
      select model, input_kind, text_hash from embedding_cache
       where user_id = ${guest.id} order by input_kind, model`;
    return rows.map((r) => ({ model: r.model, kind: r.input_kind, hash: r.text_hash }));
  }

  it("copies both input_kinds under the shelf's model, and nothing else", async () => {
    await bankTuning(DELEGATE);
    // The two that must travel: a cloned chunk's text, and a question wording
    // the guest ends up holding.
    await cacheRow(seed.id, DELEGATE, "document", "chunk zero");
    await cacheRow(seed.id, DELEGATE, "query", "what?");
    // Right model, wrong text: a passage this build does not carry. `_hash_scope`
    // is what keeps the master's other corpora out.
    await cacheRow(seed.id, DELEGATE, "document", "a passage from another corpus");
    // Right text, wrong model: the eleven-model sweep behind Appraise → Models
    // lives in this table too, and 5k must never widen into it.
    await cacheRow(seed.id, "voyage-finance-2", "document", "chunk zero");
    // The config's own base model, excluded by name.
    await cacheRow(seed.id, KEY_MODEL, "document", "chunk zero");

    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    assert.deepEqual(await copied(), [
      { model: DELEGATE, kind: "document", hash: sha256("chunk zero") },
      { model: DELEGATE, kind: "query", hash: sha256("what?") },
    ]);
    assert.equal(summary.cachedVectors, 2);
  });

  it("copies nothing when the build banked no tuning", async () => {
    await cacheRow(seed.id, DELEGATE, "document", "chunk zero");
    await cacheRow(seed.id, DELEGATE, "query", "what?");

    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    // No shelf ⇒ no models ⇒ no copy, the same gate readTuning() imposes on the
    // replayed search itself. A build that cannot install an override cannot take
    // the fusion path, so these vectors would be storage for nothing.
    assert.deepEqual(await copied(), []);
    assert.equal(summary.cachedVectors, 0);
    assert.equal(summary.cachedVectorsWanted, 0);
  });

  it("reports a short copy, so a cold master is legible at publish time", async () => {
    await bankTuning(DELEGATE);
    // The document half only. The master's cache being cold for a banked model is
    // not an error — the guest just pays for the rest, which is today's behaviour
    // — but scripts/demo-snapshot has to be able to SAY so.
    await cacheRow(seed.id, DELEGATE, "document", "chunk zero");

    const summary = await cloneSeedWorkspace(seed.id, guest.id);

    assert.equal(summary.cachedVectors, 1);
    assert.ok(
      summary.cachedVectorsWanted > summary.cachedVectors,
      "a short copy has to be visible against what a complete one would have been",
    );
  });

  it("does not stack the last build's vectors on a republish", async () => {
    await bankTuning(DELEGATE);
    await cacheRow(seed.id, DELEGATE, "document", "chunk zero");
    await cloneSeedWorkspace(seed.id, guest.id, { replaceDestination: true });
    // A row from a build this destination no longer holds. embedding_cache hangs
    // off user_profiles alone, so no cascade in step 0's delete list reaches it —
    // and its content-addressed key means a stale row is not even a conflict, just
    // storage nothing can ask about.
    await cacheRow(guest.id, DELEGATE, "document", "a passage from the last build");

    const summary = await cloneSeedWorkspace(seed.id, guest.id, { replaceDestination: true });

    assert.deepEqual(await copied(), [
      { model: DELEGATE, kind: "document", hash: sha256("chunk zero") },
    ]);
    assert.equal(summary.cachedVectors, 1);
  });
});
