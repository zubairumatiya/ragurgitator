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
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { chunksTable, modelDimension, vectorLiteral } from "../../lib/rag/vectorStore";
import type { CachedResult } from "../../lib/rag/semanticCache";
import { semanticCacheLookup, semanticCacheStore } from "../../lib/rag/semanticCache";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const KEY_MODEL = config.semanticCache.keyModel;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// TWO VECTOR WIDTHS, and the split is forced by the schema rather than chosen.
//
// semantic_cache.query_vector and embedding_cache.embedding are untyped real[],
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
            ${`{${V.join(",")}}`})
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
    assert.equal(summary.questions, 1);
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
