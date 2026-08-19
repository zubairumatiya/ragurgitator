// The semantic cache lookup, over seeded similarities.
//
// The probe moved into SQL to stop the egress bleed (docs/egress-reduction-plan.md),
// and the plan flags one behavioural trap in doing so:
//
//   > without the secondary sort, ties break arbitrarily.
//
// Its stated verification is a spot-check over recent live shadow rows, which
// will pass whether or not the sort is there: natural embeddings essentially
// never produce exactly equal cosines. So the tie is the thing this file exists
// to construct — two rows with byte-identical vectors, where "newest wins" is a
// stated fact rather than an accident of insertion order.
//
// NO PROVIDER IS CALLED. embedQueryCached checks embedding_cache before it
// embeds, so seeding that table for every question used here makes the whole
// file hermetic and lets each test state the exact geometry it wants.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import type { ResolvedConfig } from "../../lib/rag/activeConfig";
import type { CachedResult } from "../../lib/rag/semanticCache";
import { semanticCacheLookup, semanticCacheStore } from "../../lib/rag/semanticCache";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const KEY_MODEL = config.semanticCache.keyModel;

let admin: Sql;
let alice: { id: string; email: string };
let configId: string;

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

// Four dimensions, not 1024. The lookup casts real[] to vector at query time and
// never consults the model's declared dimension, so the geometry can be small
// enough to read: `1 - (a <=> b)` over these is arithmetic anyone can check.
const V = {
  q: [1, 0, 0, 0],
  same: [1, 0, 0, 0], // cosine 1.0 with q
  near: [0.98, 0.198997, 0, 0], // ≈ 0.98
  mid: [0.9, 0.435889, 0, 0], // ≈ 0.90
  far: [0.5, 0.866025, 0, 0], // ≈ 0.50
};

const RESULT = (answer: string): CachedResult => ({
  answer,
  sources: [],
  model: "test-llm",
  efficacy: null,
  escalated: false,
});

// Pre-load a question's vector so embedQueryCached returns it without embedding.
async function seedEmbedding(text: string, vector: number[]) {
  await admin`
    insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
    values (${alice.id}, ${KEY_MODEL}, 'query', ${sha256(text)}, ${vector.length},
            ${`{${vector.join(",")}}`})
    on conflict do nothing`;
}

async function inScope<T>(fn: (cfg: ResolvedConfig) => Promise<T>): Promise<T> {
  return withUser(alice, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, () => fn(cfg));
  });
}

// Bank an answer through the REAL store path, so the row carries the same
// fingerprint the lookup will compute. Building the row by hand would mean
// reimplementing currentFingerprint in the test, i.e. testing it against itself.
async function bank(question: string, vector: number[], answer: string) {
  await seedEmbedding(question, vector);
  await inScope(async () => {
    await semanticCacheStore(question, { model: KEY_MODEL, vector }, RESULT(answer));
  });
}

async function lookup(question: string, opts: { serve?: boolean; threshold?: number } = {}) {
  await seedEmbedding(question, V.q);
  return inScope(() =>
    semanticCacheLookup(question, {
      serve: opts.serve ?? true,
      // Stated per call rather than inherited: resolveThreshold falls back to a
      // calibrated per-space value, and a test whose threshold depends on another
      // table's contents is not testing the branch it says it is.
      threshold: opts.threshold ?? 0.95,
      keyModel: null,
    }),
  );
}

async function shadowRows() {
  return admin<{ matched_query: string; sim: number; guard_blocked: boolean; origin: string }[]>`
    select matched_query, sim, guard_blocked, origin
    from semantic_cache_shadow order by created_at, matched_query`;
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

// Fresh user per test: the in-process memo in embedCache is keyed by (model,
// kind, text), so reusing a question string across tests with a different vector
// would silently serve the first test's geometry to the second.
beforeEach(async () => {
  await truncateAll(admin);
  alice = await createUser(admin);
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('c', ${alice.id}) returning id`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${alice.id}, ${corpus.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  configId = cfg.id;
});

describe("semanticCacheLookup over seeded similarities", () => {
  it("misses when the user has banked nothing", async () => {
    const probe = await lookup("q-empty-1");
    assert.equal(probe.hit, false);
    assert.equal((await shadowRows()).length, 0);
  });

  it("returns the nearest row, not merely a row above the threshold", async () => {
    await bank("banked-far", V.far, "far");
    await bank("banked-near", V.near, "near");
    await bank("banked-mid", V.mid, "mid");

    const probe = await lookup("q-nearest", { threshold: 0.5 });
    assert.equal(probe.hit, true);
    assert.equal(probe.hit && probe.matchedQuery, "banked-near");
  });

  it("breaks an exact tie in favour of the newest row", async () => {
    // Byte-identical vectors: `<=>` returns exactly 0 for all four, so ORDER BY
    // has nothing but the secondary sort to go on. This is the case the live
    // spot-check cannot produce — real embeddings never tie.
    // Names carry no digits on purpose: the entity guard refuses a match whose
    // numerals differ from the question's, so `tie-2` vs `q-tie-0` would be
    // rejected before the ordering this test is about ever mattered.
    const names = ["tie-alpha", "tie-bravo", "tie-charlie", "tie-delta"];
    for (const name of names) await bank(name, V.same, `answer-${name}`);

    // Each round assigns all four timestamps in ONE statement, then probes.
    // Bumping a single row does not discriminate — the rewrite also makes it the
    // physically newest tuple, so "latest created_at" and "written last" move
    // together. One statement fixes the physical order across both rounds while
    // the logical order reverses.
    //
    // WHAT THIS TEST CAN AND CANNOT SEE. It pins the contract — the newest of
    // equally-similar rows wins — and it fails if the sort is inverted. It does
    // NOT fail if `created_at desc` is deleted from the ORDER BY, and that is not
    // a fixable weakness: semantic_cache_lookup_idx is
    // (user_id, embedding_model, llm_model, fingerprint, created_at DESC), so the
    // index already hands rows to the sort newest-first and a top-N over an
    // all-equal key keeps the first. Verified by deleting the key and watching
    // this file stay green.
    //
    // So the explicit sort is what makes the tie-break GUARANTEED rather than a
    // property of the chosen plan, and no fixture can demonstrate that difference
    // — a planner change, not a data change, is what would expose it. Do not read
    // a green run here as "the secondary sort is covered".
    const ages = (newest: string) =>
      names.map((n, i) => `('${n}', '${n === newest ? 0 : i + 1} hours')`).join(", ");

    for (const [round, newest] of [["a", "tie-charlie"], ["b", "tie-bravo"]] as const) {
      await admin.unsafe(`
        update semantic_cache c set created_at = now() - v.age::interval
        from (values ${ages(newest)}) as v(q, age)
        where c.query_text = v.q`);
      const probe = await lookup(`q-tie-${round}`);
      assert.equal(probe.hit && probe.matchedQuery, newest, `round ${round} ignored created_at`);
    }
  });

  it("shadow-logs a near miss that never reaches the serving threshold", async () => {
    await bank("shadow-mid", V.mid, "mid");

    const probe = await lookup("q-shadow", { threshold: 0.95 });
    assert.equal(probe.hit, false, "0.90 must not clear a 0.95 threshold");

    // …but it is recorded, because calibrating the threshold DOWNWARD needs
    // judged examples from below it. This is the branch that makes the shadow
    // table independent of the serving decision.
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matched_query, "shadow-mid");
    assert.ok(Math.abs(Number(rows[0].sim) - 0.9) < 0.001);
    assert.equal(rows[0].guard_blocked, false);
    assert.equal(rows[0].origin, "traffic");
  });

  it("does not shadow-log below the floor when the driver sets its own", async () => {
    await bank("under-floor", V.far, "far");
    // shadow.floor supplied ⇒ the sub-floor random sample is skipped entirely,
    // so this assertion is deterministic rather than 95% likely.
    await seedEmbedding("q-underfloor", V.q);
    const probe = await inScope(() =>
      semanticCacheLookup("q-underfloor", {
        serve: true,
        threshold: 0.95,
        keyModel: null,
        shadow: { floor: 0.8, origin: "probe" },
      }),
    );
    assert.equal(probe.hit, false);
    assert.equal((await shadowRows()).length, 0);
  });

  it("stamps a driver's shadow rows with its own origin", async () => {
    await bank("probe-origin", V.near, "near");
    await seedEmbedding("q-origin", V.q);
    await inScope(() =>
      semanticCacheLookup("q-origin", {
        serve: false,
        threshold: 0.99,
        keyModel: null,
        shadow: { floor: 0, origin: "probe" },
      }),
    );
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    // 0069 exists so a calibration sweep's engineered near-misses can be kept out
    // of the serving curve. A driver row landing as 'traffic' would poison it.
    assert.equal(rows[0].origin, "probe");
  });

  it("refuses a perfect-cosine match that disagrees on a number", async () => {
    // Same vector as the question — cosine 1.0, far above any threshold. Only the
    // entity guard can tell these apart, which is the entire point of it.
    await bank("What was revenue in 2023?", V.same, "2023 answer");

    const probe = await lookup("What was revenue in 2024?");
    assert.equal(probe.hit, false, "the guard must outrank the cosine");

    // Still shadow-logged, and flagged — the guard trades recall for safety, and
    // what it rejected is the only measure of what that cost.
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].guard_blocked, true);
    assert.ok(Math.abs(Number(rows[0].sim) - 1) < 1e-6);
  });

  it("serves a hit and counts it", async () => {
    await bank("What is the policy?", V.same, "the answer");

    const probe = await lookup("What is the policy?");
    assert.equal(probe.hit, true);
    assert.equal(probe.hit && probe.result.answer, "the answer");

    // bumpHit runs through detached(); with no queue installed it runs inline, so
    // by here it has landed. Test 7 covers the queued path.
    const [row] = await admin<{ hit_count: number; last_hit_at: Date | null }[]>`
      select hit_count, last_hit_at from semantic_cache where query_text = 'What is the policy?'`;
    assert.equal(row.hit_count, 1);
    assert.ok(row.last_hit_at);
  });

  it("reports a miss with serving off, and keeps the would-hit in the shadow log", async () => {
    await bank("serve-off", V.same, "banked");

    const probe = await lookup("q-serve-off", { serve: false });
    assert.equal(probe.hit, false);
    assert.equal(probe.hit === false && probe.key.model, KEY_MODEL);
    // The key rides back on the miss so the recomputed answer is banked without
    // re-embedding the question.
    assert.deepEqual([...(probe.hit === false ? probe.key.vector : [])], V.q);

    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.ok(Math.abs(Number(rows[0].sim) - 1) < 1e-6);

    // And no hit was counted: nothing was served.
    const [row] = await admin<{ hit_count: number }[]>`
      select hit_count from semantic_cache where query_text = 'serve-off'`;
    assert.equal(row.hit_count, 0);
  });

  it("keeps another user's rows out of the match", async () => {
    await bank("mine", V.mid, "mine");

    const bob = await createUser(admin);
    // Bob banks a PERFECT match for the question alice is about to ask. RLS is
    // what has to keep it out; the lookup's own where-clause never mentions bob.
    const [bobCorpus] = await admin<{ id: string }[]>`
      insert into corpora (name, user_id) values ('b', ${bob.id}) returning id`;
    const [bobCfg] = await admin<{ id: string }[]>`
      insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
      values (${bob.id}, ${bobCorpus.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;
    await admin`
      insert into embedding_cache (user_id, model, input_kind, text_hash, dimension, embedding)
      values (${bob.id}, ${KEY_MODEL}, 'query', ${sha256("bobs")}, 4, ${"{1,0,0,0}"})`;
    await withUser(bob, async () => {
      const cfg = await resolveConfig(bobCfg.id);
      await withConfig(cfg!, () =>
        semanticCacheStore("bobs", { model: KEY_MODEL, vector: V.same }, RESULT("bob's answer")),
      );
    });

    const probe = await lookup("q-tenant", { threshold: 0.5 });
    assert.equal(probe.hit, true);
    assert.equal(probe.hit && probe.matchedQuery, "mine", "matched across tenants");
  });
});
