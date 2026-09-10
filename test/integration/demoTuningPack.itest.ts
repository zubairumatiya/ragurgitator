// PACKING A TUNING BANK FROM A SIBLING CONFIG, against a real database —
// phase 2 of docs/demo-voyage-tuning-plan.md.
//
// The publish banks ⚙ Auto tune's winners from a sibling config tuned on one
// difficulty set, and every chunk id in the bank has to come out in the PUBLISH
// config's id space — the entry's own chunk and each trial's candidate pool —
// or clone step 5j's remap finds nothing and the guest gets an empty shelf with
// no error. The join is (document_id, position) on the base model's chunk
// table, which is exact only because the sibling is a position-for-position
// copy. What is asserted:
//
//   1. EVERY ID RESOLVES IN THE PUBLISH CONFIG: the entry's chunk and every pool
//      member are ids of B's rows, none of A's.
//   2. THE BOARD SCOPES ON THE DESTINATION SIDE: a sibling override on a chunk
//      outside B's board is not banked.
//   3. A POOL MEMBER THAT DOES NOT MAP IS DROPPED, not held: sets, the 0083 rule.
//   4. WITHOUT A SOURCE the join is the identity, so the pre-plan publish path
//      reads the config's own overrides unchanged.
//   5. THE CENSUS AGREES WITH THE PACK on the same source.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import { packTuning, tuningCensus } from "../../lib/demo/captureTuning";
import { chunksTable, modelDimension } from "../../lib/rag/vectorStore";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const MODEL = config.embeddingModel;
const DIM = modelDimension(MODEL);
const CHUNKS = chunksTable(MODEL, DIM);
const VECTOR = `[${Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

let admin: Sql;
let owner: { id: string; email: string };
// A: the sibling (tuned); B: the publish config. Same corpus, same positions.
let a: { config: string; run: string; chunks: string[] };
let b: { config: string; run: string; chunks: string[] };

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

async function seedConfig(docId: string, texts: string[]) {
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${owner.id}, ${MODEL}, 500, 50, 5, 'test-llm') returning id`;
  const [run] = await admin<{ id: string }[]>`
    insert into document_embeddings
      (document_id, model, dimension, chunk_size, chunk_overlap, chunk_count, config_id)
    values (${docId}, ${MODEL}, ${DIM}, 500, 50, ${texts.length}, ${cfg.id}) returning id`;
  const chunks: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const [row] = await admin<{ id: string }[]>`
      insert into ${admin(CHUNKS)}
        (document_id, document_embedding_id, position, text, embedding, config_id)
      values (${docId}, ${run.id}, ${i}, ${texts[i]}, ${VECTOR}, ${cfg.id}) returning id`;
    chunks.push(row.id);
  }
  return { config: cfg.id, run: run.id, chunks };
}

beforeEach(async () => {
  await truncateAll(admin);
  owner = await createUser(admin);
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('doc.md', 'hash', 'zero one two', ${owner.id}) returning id`;
  a = await seedConfig(doc.id, ["zero", "one", "two"]);
  b = await seedConfig(doc.id, ["zero", "one", "two"]);

  // A's winner on chunk 1: two re-split pieces under a second model, with one
  // trial whose pool names chunks 0, 1 and 2 of A.
  await admin`
    insert into config_chunk_overrides
      (config_id, source_chunk_id, model, dimension, embedding, piece_index, text, kind)
    values
      (${a.config}, ${a.chunks[1]}, ${MODEL}, ${DIM}, ${VECTOR}, 0, 'one (a)', 'size'),
      (${a.config}, ${a.chunks[1]}, ${MODEL}, ${DIM}, ${VECTOR}, 1, 'one (b)', 'size')`;
  await admin`
    insert into eval_model_trials
      (source_chunk_id, document_embedding_id, baseline_model, trial_model, k, pool_chunk_ids,
       question_count, hit_count, stored_hit_count, results, kind, chunk_size, piece_count)
    values
      (${a.chunks[1]}, ${a.run}, ${MODEL}, ${MODEL}, 5, ${a.chunks}::uuid[],
       1, 1, 0, ${admin.json([{ question: "what is one?", storedHit: false, storedRank: null, newHit: true, newRank: 1, newScore: 0.9 }])},
       'size', 256, 2)`;
  // And a winner on chunk 2, which B's board below leaves out.
  await admin`
    insert into config_chunk_overrides
      (config_id, source_chunk_id, model, dimension, embedding, piece_index, text, kind)
    values (${a.config}, ${a.chunks[2]}, ${MODEL}, ${DIM}, ${VECTOR}, 0, null, 'model')`;
});

describe("packTuning from a sibling", () => {
  it("rewrites the entry's chunk and every pool id into the publish config's space", async () => {
    const board = [b.chunks[0], b.chunks[1]];
    const bank = await packTuning(b.config, board, MODEL, a.config);
    assert.equal(bank.entries.length, 1);
    const [entry] = bank.entries;
    assert.equal(entry.chunk, b.chunks[1]);
    assert.equal(entry.kind, "size");
    assert.deepEqual(
      entry.pieces.map((p) => p.text),
      ["one (a)", "one (b)"],
    );
    assert.equal(entry.trials.length, 1);
    assert.deepEqual(entry.trials[0].pool, b.chunks);
    // None of A's ids survive anywhere in the payload.
    const text = JSON.stringify(bank);
    for (const id of a.chunks) assert.ok(!text.includes(id), `sibling id ${id} leaked into the bank`);
  });

  it("scopes to the board on the destination side", async () => {
    const bank = await packTuning(b.config, [b.chunks[0], b.chunks[2]], MODEL, a.config);
    assert.deepEqual(
      bank.entries.map((e) => e.chunk),
      [b.chunks[2]],
    );
  });

  it("drops a pool member that does not map rather than holding its place", async () => {
    // Give A a fourth chunk B does not have, and put it in the pool.
    const [extra] = await admin<{ id: string }[]>`
      insert into ${admin(CHUNKS)}
        (document_id, document_embedding_id, position, text, embedding, config_id)
      select id, ${a.run}, 3, 'three', ${VECTOR}, ${a.config}
        from documents limit 1 returning id`;
    await admin`
      update eval_model_trials set pool_chunk_ids = pool_chunk_ids || ${extra.id}::uuid
       where source_chunk_id = ${a.chunks[1]}`;
    const bank = await packTuning(b.config, [b.chunks[1]], MODEL, a.config);
    assert.deepEqual(bank.entries[0].trials[0].pool, b.chunks);
  });

  it("without a source, reads the config's own overrides through the identity map", async () => {
    // B tunes chunk 0 itself.
    await admin`
      insert into config_chunk_overrides
        (config_id, source_chunk_id, model, dimension, embedding, piece_index, text, kind)
      values (${b.config}, ${b.chunks[0]}, ${MODEL}, ${DIM}, ${VECTOR}, 0, null, 'model')`;
    const own = await packTuning(b.config, b.chunks, MODEL);
    assert.deepEqual(
      own.entries.map((e) => e.chunk),
      [b.chunks[0]],
    );
    // And A's overrides do not bleed in through a same-position join on B.
    const fromA = await packTuning(b.config, b.chunks, MODEL, a.config);
    assert.deepEqual(
      fromA.entries.map((e) => e.chunk).sort(),
      [b.chunks[1], b.chunks[2]].sort(),
    );
  });

  it("the census counts the same rows the pack banks", async () => {
    const board = [b.chunks[0], b.chunks[1]];
    const census = await tuningCensus(b.config, board, MODEL, a.config);
    assert.deepEqual(census, {
      boardChunks: 2,
      overridden: 1,
      overrideRows: 2,
      trials: 1,
      foreign: 0,
    });
  });
});
