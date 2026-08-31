// THE DEEP FUSION POOL, and what it is allowed to carry (docs/fusion-egress-plan.md §1.2).
//
// Phase 3 stops the base ANN selecting `text` on all deepN rows. The saving is
// invisible to a unit test and invisible to a local Postgres bill, so what this
// file asserts is the OBSERVABLE consequence of the change rather than the bytes:
//
//   1. On a base-space config the merge returns an EMPTY meta map — the pool rows
//      carry no text at all — and retrieval still hands back the real text for
//      the topK, resolved by id. That is "topK texts, not deepN", stated as the
//      two halves it actually decomposes into.
//   2. On a FOREIGN-space config the pool keeps its text, because the deeper
//      candidates are looked up in the doc-vector cache BY TEXT. Trimming it
//      there would silently drop those free candidates from competitorSims — a
//      change to the candidate set, which is a FUSION_VERSION bump (DECISION 2).
//      So the assertion is that the deeper free candidates are STILL THERE,
//      read off the screen cutoff they set.
//
// It needs a real database because every piece of it is SQL: two ANN variants, a
// group-by in config_chunk_overrides, and resolveChunks. No provider is ever
// called — every vector the retriever would embed is pre-seeded into
// embedding_cache, which is the same trick demoClone.itest.ts uses.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { fragment, privilegedSql } from "../../lib/db";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { sameVectorSpace } from "../../lib/rag/embeddingModels";
import {
  buildRetrievalContext,
  fuseWithOverrides,
  retrieveWithCutoffs,
} from "../../lib/rag/retriever";
import { listOverrides, overrideSims } from "../../lib/rag/overrideStore";
import { chunksTable, queryExcludingIds, vectorLiteral } from "../../lib/rag/vectorStore";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const BASE_MODEL = "voyage-4-lite";
const DIM = 1024;
const CHUNKS = chunksTable(BASE_MODEL, DIM);
// Same vectorSpace as the base ⇒ folds into the base lane, no pool text needed.
const SAME_SPACE_MODEL = "voyage-4";
// A genuinely private space ⇒ opens a fusion lane, re-embeds the pool, and is
// the one caller that still needs every deepN text.
const FOREIGN_MODEL = "embed-english-light-v3";

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// A unit vector in the (e0, e1) plane whose cosine against e0 is exactly `c`.
// Every score in this file is therefore a stated constant rather than something
// the test has to discover.
const atCosine = (c: number, dim: number): number[] => {
  const v = new Array(dim).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
};
const E0 = (dim: number): number[] => atCosine(1, dim);

const QUESTION = "which chunk?";

// Base corpus: six chunks at descending, well-separated cosines against the
// query. Gaps are wide so a float difference can never reorder them.
const BASE_SCORES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
const TEXT = (i: number) => `chunk text number ${i}`;

let admin: Sql;
let user: { id: string; email: string };
let configId: string;
let chunkIds: string[];

async function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return withUser(user, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

// Bank a vector where the embed cache will find it, so the retriever's
// embedQueryCached / embedDocsCached / cachedDocVectors never reach a provider.
async function bank(kind: "query" | "document", model: string, text: string, vec: number[]) {
  await admin`
    insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
    values (${user.id}, ${model}, ${kind}, ${sha256(text)}, ${vec.length},
            ${`{${vec.join(",")}}`})
    on conflict do nothing`;
}

// One override piece on `chunkIds[index]`. Written directly rather than through
// setChunkOverridePieces: what is under test is retrieval, and a fixture that
// states its own rows is a fixture that can be read.
async function override(index: number, model: string, vec: number[]) {
  await admin`
    insert into config_chunk_overrides
      (config_id, source_chunk_id, piece_index, model, dimension, kind,
       text, token_start, token_end, embedding)
    values (${configId}, ${chunkIds[index]}, 0, ${model}, ${vec.length}, 'model',
            null, null, null, ${`{${vec.join(",")}}`}::real[])`;
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
  user = await createUser(admin);

  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('pool corpus', ${user.id}) returning id`;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('a.txt', ${sha256("a")}, 'the body', ${user.id}) returning id`;
  await admin`
    insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${doc.id})`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${user.id}, ${corpus.id}, ${BASE_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  configId = cfg.id;

  const [run] = await admin<{ id: string }[]>`
    insert into document_embeddings
      (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
    values (${doc.id}, ${BASE_MODEL}, ${DIM}, 500, 50, ${BASE_SCORES.length}, ${cfg.id})
    returning id`;

  chunkIds = [];
  for (const [i, score] of BASE_SCORES.entries()) {
    const [row] = await admin<{ id: string }[]>`
      insert into ${admin(CHUNKS)}
        (document_id, document_embedding_id, position, text, embedding, config_id)
      values (${doc.id}, ${run.id}, ${i}, ${TEXT(i)},
              ${vectorLiteral(atCosine(score, DIM))}, ${cfg.id})
      returning id`;
    chunkIds.push(row.id);
  }

  // The base query vector, so nothing embeds it.
  await bank("query", BASE_MODEL, QUESTION, E0(DIM));
});

describe("the deep fusion pool", () => {
  it("selects id and score only — the rows carry no text", async () => {
    const rows = await inScope(() => queryExcludingIds(E0(DIM), 10, []));

    assert.equal(rows.length, BASE_SCORES.length);
    // Ranked the same way the text-carrying variant ranks.
    assert.deepEqual(
      rows.map((r) => r.chunk.chunk.id),
      chunkIds,
    );
    for (const r of rows) {
      assert.equal(r.chunk.chunk.text, "", "the pool must not ship chunk text");
      assert.equal(r.chunk.chunk.documentId, "");
    }
  });

  describe("with a BASE-SPACE override (the demo's shape)", () => {
    beforeEach(async () => {
      // The weakest base chunk, overridden to beat everything. Same vectorSpace,
      // so it folds into the base lane and no pool text is needed anywhere.
      await override(5, SAME_SPACE_MODEL, atCosine(0.95, DIM));
      assert.ok(sameVectorSpace(SAME_SPACE_MODEL, BASE_MODEL), "fixture assumes a fold");
    });

    it("fuses without fetching any pool text", async () => {
      const { merged, meta } = await inScope(async () =>
        fuseWithOverrides(QUESTION, E0(DIM), 3, await listOverrides(), (m, qv) =>
          overrideSims(m, qv),
        ),
      );

      // THE assertion: not one base-pool row carried metadata, so not one
      // carried text. Before phase 3 this map held all deepN of them.
      assert.equal(meta.size, 0);
      // ...and the merge is unchanged: the override outranks every base chunk.
      assert.equal(merged[0].id, chunkIds[5]);
      assert.deepEqual(merged.map((c) => c.id), [chunkIds[5], ...chunkIds.slice(0, 5)]);
    });

    it("resolves text for the topK it keeps, and only those", async () => {
      const k = 3;
      const resolved: string[][] = [];

      const retrieved = await inScope(async () => {
        const ctx = await buildRetrievalContext();
        const spied = { ...ctx, resolve: (ids: string[]) => (resolved.push(ids), ctx.resolve(ids)) };
        return (await retrieveWithCutoffs(QUESTION, E0(DIM), k, spied)).retrieved;
      });

      // One resolve, for exactly the k ids that survived — never the six-row pool.
      assert.deepEqual(resolved, [[chunkIds[5], chunkIds[0], chunkIds[1]]]);
      assert.deepEqual(
        retrieved.map((r) => r.chunk.chunk.text),
        [TEXT(5), TEXT(0), TEXT(1)],
      );
      assert.equal(retrieved.length, k);
    });
  });

  describe("with a FOREIGN-space override", () => {
    // 4 dims: config_chunk_overrides.embedding and embedding_cache.embedding are
    // untyped real[], so the foreign lane can use a width a human can read.
    const FDIM = 4;
    // The deeper candidates' cosines under the foreign model. c2 is the STRONGEST
    // competitor in this space — deliberately, because if the deeper rows were
    // dropped it would vanish and the cutoff would move.
    const PAID = [0.3, 0.2];
    const DEEPER: Record<number, number | null> = { 2: 0.9, 3: null, 4: 0.1 };

    beforeEach(async () => {
      await override(5, FOREIGN_MODEL, atCosine(0.5, FDIM));
      assert.ok(!sameVectorSpace(FOREIGN_MODEL, BASE_MODEL), "fixture assumes a fusion lane");

      await bank("query", FOREIGN_MODEL, QUESTION, E0(FDIM));
      // The paid pool: the top `paidN` base texts, re-embedded under the foreign
      // model. Banked, so embedDocsCached is a hit.
      for (const [i, c] of PAID.entries()) await bank("document", FOREIGN_MODEL, TEXT(i), atCosine(c, FDIM));
      // The free deeper candidates. Chunk 3 is deliberately NOT banked: a
      // cache-only reader drops what it cannot find.
      for (const [i, c] of Object.entries(DEEPER)) {
        if (c !== null) await bank("document", FOREIGN_MODEL, TEXT(Number(i)), atCosine(c, FDIM));
      }
    });

    it("keeps its deepN text, so the free deeper candidates still compete", async () => {
      const k = 2;
      const { meta, cutoffs } = await inScope(async () =>
        fuseWithOverrides(
          QUESTION,
          E0(DIM),
          k,
          await listOverrides(),
          (m, qv) => overrideSims(m, qv),
          // paidN = 2, so chunks 2..4 are the deeper free tier.
          2,
        ),
      );

      // The pool kept its text on this branch — cachedDocVectors is keyed by it.
      assert.equal(meta.size, 5, "every non-overridden base chunk, with metadata");
      assert.equal(meta.get(chunkIds[4])!.text, TEXT(4));

      // competitorSims = paid [0.3, 0.2] + free [0.9, 0.1] (chunk 3 uncached).
      // The k-th strongest of those four is 0.3. Were the deeper rows dropped it
      // would be 0.2 — that difference IS the candidate-set change §1.2 refuses.
      assert.ok(
        Math.abs(cutoffs.models[FOREIGN_MODEL] - 0.3) < 1e-6,
        `expected the 2nd-strongest of four competitors (0.3), got ${cutoffs.models[FOREIGN_MODEL]}`,
      );
    });
  });
});
