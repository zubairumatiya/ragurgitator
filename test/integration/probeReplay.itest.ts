// PROBE REPLAY — the three rails of docs/probe-replay-plan.md, Phase 4.
//
// Probe replay pushes generated pair texts back through the REAL lookup so §3's
// Accept/Reject queue has something in it before an account has months of
// traffic. Running the real lookup is the point — a probe has to be what the
// cache would actually have done — and it is also what makes the pass one wrong
// option away from being destructive. Three properties have to hold, and none of
// them shows up as an error when it breaks:
//
//   1. NO VERDICT IS EVER WRITTEN. Probe rows stock the queue, not the curve.
//      Copying the pair's own label across would give an instant calibration
//      curve off a generator F3 measured at 80% correct on hard negatives — and
//      §3's τ becomes a LIVE serving threshold via ApplyThresholdPanel.
//   2. THE SWEEP IS UNAFFECTED. Held by unit tests over poolPairs, which is pure
//      (lib/rag/keyModelSweepCore.test.ts) — not repeated here.
//   3. A PROBE NEVER BANKS. A pass that stored its own variants would let the
//      next pass self-match them at cosine 1.0 and measure nothing.
//
// scripts/guards.ts sweep 7 holds 1 and 3 STRUCTURALLY — recordShadow's insert
// carries no verdict key, and the probe path cannot reach either writer of
// semantic_cache. This file is the other half: that the code as assembled
// actually behaves that way when run against a real schema. The guard survives an
// edit that keeps the shape and changes the behaviour; this file survives an edit
// that keeps the behaviour and changes the shape.
//
// It is also, as of writing, THE ONLY EXECUTION probe replay has ever had. Every
// phase shipped on a typecheck and a unit test; no live job has been run. So the
// eligibility query — four scoping columns against tables no unit test can see —
// is exercised here too.
//
// NO PROVIDER IS CALLED. embedQueryCached checks embedding_cache before it
// embeds, so seeding that table for every text makes the file hermetic, exactly
// as semanticCache.itest.ts does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { DEMO_ACTIONS, assertDemoAllows } from "../../lib/demo/policy";
import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import type { ResolvedConfig } from "../../lib/rag/activeConfig";
import {
  eligiblePairs,
  poolSafeProbes,
  probeRow,
  replayPairs,
  selectOneProbe,
} from "../../lib/rag/probeReplay";
import type { CachedResult } from "../../lib/rag/semanticCache";
import { semanticCacheStore } from "../../lib/rag/semanticCache";
import {
  adminClient,
  createUser,
  ensureAppRole,
  truncateAll,
} from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const KEY_MODEL = config.semanticCache.keyModel;

let admin: Sql;
let alice: { id: string; email: string };
let configId: string;
let documentId: string;

const sha256 = (t: string) =>
  createHash("sha256").update(t, "utf8").digest("hex");

// Four dimensions rather than 1024, for the reason semanticCache.itest.ts gives:
// the lookup casts real[] to vector at query time and never consults the model's
// declared dimension, so the geometry can be small enough to read.
const V = {
  origin: [1, 0, 0, 0],
  near: [0.98, 0.198997, 0, 0], // ≈ 0.98 against origin — a near miss
  far: [0.5, 0.866025, 0, 0], // ≈ 0.50
};

const RESULT = (answer: string): CachedResult => ({
  answer,
  sources: [],
  model: "test-llm",
  efficacy: null,
  escalated: false,
});

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

// Bank through the REAL store path so the row carries the fingerprint the lookup
// will compute. Building it by hand would mean reimplementing currentFingerprint
// in the test, i.e. testing it against itself.
async function bank(question: string, vector: number[], answer: string) {
  await seedEmbedding(question, vector);
  await inScope(() =>
    semanticCacheStore(question, { model: KEY_MODEL, vector }, RESULT(answer)),
  );
}

// One generated pair, with its eval question. `text_a` is the origin here, but
// nothing downstream may assume that — F3 established insertPairs canonicalises
// by hash, which is why eligiblePairs resolves the roles through variantOf
// against the question text rather than by position.
async function generatePair(
  origin: string,
  variant: string,
  opts: {
    difficulty?: "paraphrase" | "hard-negative";
    // The audit's verdict, when there is one. A verdict that CONTRADICTS the
    // constructed label is what quarantines the pair — the same (verdict, label)
    // expression listPairs filters on, which is why the fixture writes a verdict
    // rather than a flag: there is no flag column, and a fixture inventing one
    // would be testing something the sweep does not read.
    verdict?: "accept" | "reject";
  } = {},
): Promise<string> {
  const [q] = await admin<{ id: string }[]>`
    insert into eval_questions (document_id, question)
    values (${documentId}, ${origin}) returning id`;
  const [pair] = await admin<{ id: string }[]>`
    insert into semantic_cache_pairs
      (origin_question_id, text_a, text_b, hash_a, hash_b, label, difficulty,
       generated_by, verdict)
    values (${q.id}, ${origin}, ${variant}, ${sha256(origin)}, ${sha256(variant)},
            ${opts.difficulty === "paraphrase" ? "same" : "different"},
            ${opts.difficulty ?? "hard-negative"}, 'test-generator',
            ${opts.verdict ?? null})
    returning id`;
  return pair.id;
}

// Run the replay the way the background step does: choose from what is eligible,
// then replay. No arguments are invented here — the point is to exercise the
// production path, PROBE_LOOKUP included.
async function replayEverything() {
  return inScope(async () => {
    const pairs = await eligiblePairs();
    for (const p of pairs) await seedEmbedding(p.variantText, V.near);
    return { eligible: pairs.length, ...(await replayPairs(pairs)) };
  });
}

const shadowRows = () =>
  admin<
    {
      new_query: string;
      matched_query: string;
      sim: number;
      origin: string;
      verdict: string | null;
      judge_source: string | null;
      judge_model: string | null;
      judged_at: Date | null;
    }[]
  >`
    select new_query, matched_query, sim, origin, verdict, judge_source, judge_model, judged_at
    from semantic_cache_shadow order by created_at, new_query`;

// hit_count and last_hit_at are here for a specific reason, and rail 3 is much
// weaker without them.
//
// `replayPairs` never calls semanticCacheStore — in the app it is the CALLER that
// banks on a miss, and the replay has no such caller. So a lost `serve: false`
// does not insert a row, and a rail that only counted rows would stay green
// through exactly the edit it exists to catch. What a served hit DOES touch is
// bumpHit: hit_count + 1 and a fresh last_hit_at, inline here because `detached`
// runs its task immediately outside a request scope. That is the observable
// difference between "the probe measured the cache" and "the probe used it".
const cacheRows = () =>
  admin<{ query_text: string; hit_count: number; last_hit_at: Date | null }[]>`
    select query_text, hit_count, last_hit_at from semantic_cache order by query_text`;

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

// Fresh user per test, for the reason semanticCache.itest.ts documents: the
// in-process memo in embedCache is keyed by (model, kind, text), so reusing a
// question string across tests with a different vector would silently serve the
// first test's geometry to the second.
beforeEach(async () => {
  await truncateAll(admin);
  alice = await createUser(admin);
  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('c', ${alice.id}) returning id`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${alice.id}, ${corpus.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  configId = cfg.id;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('d.txt', ${`h-${alice.id}`}, 'body', ${alice.id}) returning id`;
  documentId = doc.id;
});

describe("probe replay against a real schema", () => {
  it("RAIL 1: writes shadow rows and leaves every one of them unjudged", async () => {
    // The pair's own label says "different". A replay that trusted it would have
    // everything it needs to write `verdict = 'reject'` right here, and the
    // calibration curve would move on an unaudited generator's say-so.
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
    );

    const run = await replayEverything();
    assert.equal(run.eligible, 1);
    assert.equal(run.probed, 1);
    assert.equal(run.failed, 0);

    const rows = await shadowRows();
    assert.equal(
      rows.length,
      1,
      "a reachable origin must produce a shadow row",
    );
    assert.equal(
      rows[0].new_query,
      "what does the policy exclude from coverage",
    );
    assert.equal(
      rows[0].matched_query,
      "what does the policy say about coverage",
    );
    assert.equal(
      rows[0].origin,
      "probe",
      "the row must be attributable as a probe (0069)",
    );
    // THE RAIL. All four judging columns, not just `verdict`: a row carrying a
    // judge model or a judged_at with a null verdict would be a half-written
    // judgement, and calibrationCurve counts on verdict alone.
    assert.equal(rows[0].verdict, null);
    assert.equal(rows[0].judge_source, null);
    assert.equal(rows[0].judge_model, null);
    assert.equal(rows[0].judged_at, null);
  });

  it("RAIL 1 holds for a paraphrase too — the label is never the verdict", async () => {
    // The other label. A shortcut that mapped 'same' → 'accept' would look
    // harmless (accepts are the majority anyway) and would still be an unaudited
    // label reaching a serving threshold.
    await bank("when does the term begin", V.origin, "on signing");
    await generatePair("when does the term begin", "when does the term start", {
      difficulty: "paraphrase",
    });

    await replayEverything();
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, null);
  });

  it("RAIL 3: a probe banks nothing — semantic_cache is untouched", async () => {
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
    );
    const before = await cacheRows();
    assert.equal(before.length, 1, "only the banked origin");

    await replayEverything();

    assert.deepEqual(
      await cacheRows(),
      before,
      "the replay changed semantic_cache",
    );
  });

  it("RAIL 3 holds when the probe WOULD have been a hit", async () => {
    // THE VERSION THAT ACTUALLY CATCHES A LOST serve:false. The rail above passes
    // trivially when nothing clears the threshold — there is no serve branch to
    // take. Here the variant's vector is byte-identical to the banked origin, so
    // the match is cosine 1.0 and serving, if it were on, would return a hit and
    // bump the origin's hit_count. Verified by flipping PROBE_LOOKUP to
    // serve:true and watching this one go red.
    const text = "what does the policy say about coverage";
    await bank(text, V.origin, "covered");
    await generatePair(text, "what does the policy state about coverage");
    await inScope(async () => {
      // Same vector as the origin: cosine 1.0.
      await seedEmbedding(
        "what does the policy state about coverage",
        V.origin,
      );
    });

    const before = await cacheRows();
    await replayEverything();

    assert.deepEqual(await cacheRows(), before, "a would-be hit was banked");
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, null, "a would-be hit is still unjudged");
  });

  it("eligibility needs the origin BANKED, not merely present", async () => {
    // The constraint the whole feature rests on (f1-negatives.ts:21-23): the
    // lookup searches semantic_cache, so a pair whose origin question has never
    // been ASKED has nothing to nearly-match and would land on some unrelated
    // entry — measuring nothing while looking like it worked.
    await generatePair("a question nobody has ever asked", "a variant of it");

    const run = await replayEverything();
    assert.equal(run.eligible, 0);
    assert.equal((await shadowRows()).length, 0);
  });

  it("a probed pair drops out of eligibility, so a top-up run re-probes nothing", async () => {
    // What makes the trigger safe to fire after every pair generation, and what
    // the job's frozen cursor exists to cope with — the work consumes its own
    // eligibility (lib/jobs/steps/probeReplay.ts).
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
    );

    assert.equal((await replayEverything()).probed, 1);
    const afterFirst = await shadowRows();

    const second = await replayEverything();
    assert.equal(
      second.eligible,
      0,
      "an already-probed variant is still eligible",
    );
    assert.deepEqual(
      await shadowRows(),
      afterFirst,
      "a second run changed the queue",
    );
  });

  it("finds the pair when the VARIANT is stored as text_a", async () => {
    // insertPairs canonicalises by hash, so the origin is not reliably text_a —
    // F3 measured that directly. eligiblePairs resolves the roles through
    // variantOf against the question text; a positional assumption would probe
    // the ORIGIN instead, which self-matches at cosine 1.0 and measures nothing.
    const origin = "what does the policy say about coverage";
    const variant = "what does the policy exclude from coverage";
    await bank(origin, V.origin, "covered");
    const [q] = await admin<{ id: string }[]>`
      insert into eval_questions (document_id, question)
      values (${documentId}, ${origin}) returning id`;
    await admin`
      insert into semantic_cache_pairs
        (origin_question_id, text_a, text_b, hash_a, hash_b, label, difficulty, generated_by)
      values (${q.id}, ${variant}, ${origin}, ${sha256(variant)}, ${sha256(origin)},
              'different', 'hard-negative', 'test-generator')`;

    await replayEverything();
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].new_query,
      variant,
      "the ORIGIN was probed, not the variant",
    );
  });

  it("records a probe below the shadow floor — the pass chooses its own floor", async () => {
    // PROBE_LOOKUP passes floor 0, so a distant near-miss is still recorded where
    // the live path would drop it (shadowLogFloor is 0.80). Deliberate: F2 wanted
    // the below-floor sample, and calibrationCurve hides that band by default
    // rather than never collecting it.
    await bank("what does the policy say about coverage", V.origin, "covered");
    const pairId = await generatePair(
      "what does the policy say about coverage",
      "an entirely unrelated matter",
    );
    assert.ok(pairId);

    await inScope(async () => {
      const pairs = await eligiblePairs();
      for (const p of pairs) await seedEmbedding(p.variantText, V.far);
      await replayPairs(pairs);
    });

    const rows = await shadowRows();
    assert.equal(rows.length, 1, "a sub-floor probe must still be recorded");
    assert.ok(rows[0].sim < config.semanticCache.shadowLogFloor);
    assert.equal(rows[0].verdict, null);
  });
});

// --- Phase 4: the guest's single probe ---------------------------------------
//
// docs/demo-cache-lab-plan.md revises merged main's position deliberately. The
// bulk job stays blocked — 40 embeddings fired by a trigger nobody pressed — and
// a SINGLE probe becomes something a visitor may ask for, at the cost of one
// question. Three things separate it from the job, and all three are the kind
// that fail quietly:
//
//   • it records at the REAL floor, not PROBE_LOOKUP's 0, so the guest's row sits
//     in the same band as the sample lib/demo/clone step 5b strides around it;
//   • it never chooses a QUARANTINED pair, because cloning the pair bank into the
//     account that writes the probe rows puts both halves of the F3 dedupe
//     collision in one workspace;
//   • the row still lands unjudged, which is what makes it honest.
//
// The route (app/api/semantic-cache/probe) is the same three calls in the same
// order; it is not driven here for the reason the job is not — the transport is
// Next's, and the decisions are the module's.

const FLOOR = config.semanticCache.shadowLogFloor;

// What POST /api/semantic-cache/probe does, minus the transport: choose one
// pool-safe pair, replay it at the live floor, read the row back.
async function guestProbe(vector: number[]) {
  return inScope(async () => {
    const pair = selectOneProbe(poolSafeProbes(await eligiblePairs()));
    if (!pair) return { pair: null, run: null, row: null };
    await seedEmbedding(pair.variantText, vector);
    const run = await replayPairs([pair], undefined, undefined, FLOOR);
    return { pair, run, row: await probeRow(pair.variantText) };
  });
}

describe("the guest's single probe (docs/demo-cache-lab-plan.md, Phase 4)", () => {
  it("uses the REAL floor: a sub-floor near-miss queues nothing", async () => {
    // The difference from the job in one assertion. Under PROBE_LOOKUP's floor of
    // 0 this same 0.50 match records a row — the test above this one proves it —
    // and that row would be the only thing in a guest's queue nowhere near the
    // band every other row came from, with nothing on screen to say so.
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "an unrelated matter",
    );

    const probe = await guestProbe(V.far);
    assert.ok(probe.pair, "nothing was eligible to probe");
    assert.equal(probe.run?.probed, 1, "the probe itself must still have run");
    assert.equal(probe.row, null, "a sub-floor probe reached the queue");
    assert.equal((await shadowRows()).length, 0);
  });

  it("above the floor: one row, unjudged, attributable as a probe", async () => {
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
    );

    const probe = await guestProbe(V.near);
    assert.equal(probe.run?.probed, 1);
    assert.ok(probe.row, "an above-floor probe must reach the queue");
    assert.ok(probe.row.sim >= FLOOR);
    assert.equal(
      probe.row.matchedQuery,
      "what does the policy say about coverage",
    );

    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "probe");
    // THE RULE THAT MAKES A GUEST-AUTHORED ROW HONEST. Their question sits in the
    // queue with nothing claiming to have judged it — the same four columns rail
    // 1 pins for the job, because a guest path that took the shortcut would be
    // moving a live serving threshold on a generator F3 measured at 80% correct.
    assert.equal(rows[0].verdict, null);
    assert.equal(rows[0].judge_source, null);
    assert.equal(rows[0].judge_model, null);
    assert.equal(rows[0].judged_at, null);
  });

  it("never probes a pair the label audit disproved, even when it ranks first", async () => {
    // Rigged so a missing filter FAILS rather than gets lucky: the quarantined
    // pair is the hard negative, which selectProbes prefers over a paraphrase, so
    // the clean pair can only win by being the only candidate left.
    await bank("when does the term begin", V.origin, "on signing");
    await generatePair("when does the term begin", "when does the term start", {
      difficulty: "paraphrase",
    });
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
      // 'different' label, 'accept' verdict — the audit contradicting the
      // generator, which is precisely F3's 15 rows.
      { difficulty: "hard-negative", verdict: "accept" },
    );

    const probe = await guestProbe(V.near);
    assert.equal(
      probe.pair?.variantText,
      "when does the term start",
      "a quarantined pair was probed",
    );
    const rows = await shadowRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].new_query, "when does the term start");
  });

  it("a workspace whose only eligible pair is quarantined probes nothing", async () => {
    // The end state of the rule: refusing to probe is the correct outcome, not a
    // reason to reach for the next-best row. The panel says there is nothing to
    // probe; F3's disproved pairs stay out of §3's queue.
    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
      { verdict: "accept" },
    );

    const probe = await guestProbe(V.near);
    assert.equal(probe.pair, null);
    assert.equal((await shadowRows()).length, 0);
    // eligiblePairs itself still returns it — the flag is a column, not a WHERE
    // clause, because the bulk job's rows are dropped by poolPairs downstream and
    // the two policies are applied in the pure core.
    const eligible = await inScope(() => eligiblePairs());
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].quarantined, true);
  });

  it("the BULK job is still blocked for the very guest who may probe", async () => {
    // The split, stated where it can be checked. DEMO_ACTIONS.probeReplay and
    // app/api/jobs' DEMO_ACTION_FOR_JOB are untouched by this phase — the single
    // probe is a different door, not a hole in that one. (That the jobs route
    // reads this action for `probe_replay` is held by its exhaustive Record and
    // scripts/guards.ts sweep 5; what is checked here is that the gate still
    // fires for a guest at all, since a single-probe path is exactly the change
    // that would tempt someone to loosen it.)
    await admin`
      update user_profiles
         set is_guest = true, expires_at = now() + interval '2 hours'
       where id = ${alice.id}`;

    await bank("what does the policy say about coverage", V.origin, "covered");
    await generatePair(
      "what does the policy say about coverage",
      "what does the policy exclude from coverage",
    );

    await inScope(async () => {
      await assert.rejects(
        () => assertDemoAllows("probeReplay"),
        (err: Error) => err.message === DEMO_ACTIONS.probeReplay,
        "a guest could stock the queue in bulk",
      );
    });

    // And the single probe, for that same guest, still lands its one row.
    const probe = await guestProbe(V.near);
    assert.equal(probe.run?.probed, 1);
    assert.ok(probe.row);
    assert.equal((await shadowRows())[0].verdict, null);
  });
});
