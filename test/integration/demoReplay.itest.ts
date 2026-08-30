// SERVING THE MATRIX, against a real database — phase 3 of
// docs/demo-cache-replay-plan.md.
//
// lib/demo/replayViewCore.test.ts covers the arithmetic, which is the half that is
// a pure function of three arguments. Everything that makes the replay a FEATURE
// is the half a unit test cannot reach: the progress row a click writes, the
// guest's own shadow log joining to a banked cosine by pair identity, and the
// guest-only carve-out that every route on that page now hangs its gate on.
//
// What is asserted here, and why each is a real failure mode rather than a
// tautology:
//
//   1. `n` PERSISTS AND IS CONTINUOUS. The slider's whole claim is that a guest
//      walks into the measurement at any size; a progress row that did not
//      survive the request would leave every reload back at zero, and nothing
//      would error.
//   2. THE SHADOW HALF JOINS BY PAIR IDENTITY. This is the one seam between two
//      tables that share no key — the matrix carries a hash of two texts, the
//      shadow log carries the texts — so a change to either side silently empties
//      the pool rather than failing.
//   3. A HAND VERDICT MOVES THE LEADERBOARD. §2's queue promises exactly that,
//      and it is the causal chain the plan turns on.
//   4. THE SCREEN RESOLVES THE QUARANTINE, and the pool shrinks when it does.
//   5. EVERY ENTRY POINT IS NULL FOR A REAL ACCOUNT. That null is what four
//      routes' gates hang on; if it became a zero-count result, a real account's
//      generate would be swallowed by the demo's carve-out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import {
  forgetBoard,
  forgetMatrix,
  forgetRankings,
  forgetTuning,
  readBoard,
  readIdeals,
  readLlmRankings,
  readTuning,
  writeBoard,
  writeIdeals,
  writeLlmRankings,
  writeMatrix,
  writeShadowVerdicts,
  writeTuning,
} from "../../lib/demo/replay";
import {
  packEmbedding,
  packMatrix,
  pairIdentity,
  questionIdentity,
  unpackEmbedding,
  type ReplayBoard,
  type ReplayPair,
  type ReplayRankings,
  type ReplayTuning,
} from "../../lib/demo/replayCore";
import {
  advanceReplay,
  replayBankCounts,
  replayJudgeQueue,
  replayPairsFloor,
  replaySweepResult,
  screenReplay,
} from "../../lib/demo/replayView";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const KEY_MODEL = config.semanticCache.keyModel;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

let admin: Sql;
let guest: { id: string; email: string };
let real: { id: string; email: string };
let configId: string;

// Two shadow pairs the guest's log will carry, and four generated ones. The
// TEXTS are what the shadow rows hold and the HASH is what the matrix holds —
// deriving the second from the first here is the point: it is the same identity
// the publish computes, and if the two ever stop agreeing this file is where it
// shows.
const SHADOW_TEXTS: [string, string][] = [
  ["what is the fee?", "how much does it cost?"],
  ["when does it start?", "who signs it?"],
];

const gen = (n: number, label: "same" | "different", quarantined = false): ReplayPair => ({
  hash: `generated-${n}`,
  label,
  source: "generated",
  difficulty: label === "same" ? "paraphrase" : "hard-negative",
  quarantined,
});

const shadowPair = (i: number, label: "same" | "different"): ReplayPair => ({
  hash: pairIdentity(...SHADOW_TEXTS[i]),
  label,
  source: "shadow",
  origin: "traffic",
  difficulty: null,
  // A shadow row is never quarantined — the quarantine is a verdict on a
  // GENERATED pair's label — but the field is not optional, so it is stated.
  quarantined: false,
});

// Generated and shadow interleaved, because "the first n generated" is not "the
// first n rows" and a matrix sorted by source would hide the difference.
const PAIRS: ReplayPair[] = [
  gen(1, "same"),
  shadowPair(0, "same"),
  gen(2, "different"),
  gen(3, "same", true),
  shadowPair(1, "different"),
  gen(4, "different"),
];
const SIMS = [0.97, 0.95, 0.4, 0.93, 0.3, 0.35];

const matrix = () =>
  packMatrix({
    models: [KEY_MODEL, "text-embedding-3-small"],
    pairs: PAIRS,
    sims: [SIMS, SIMS.map((s) => s - 0.05)],
    target: 0.9,
    minSamples: 2,
  });

// Everything under test runs inside a user scope, and the sweep also needs a
// config: its target is a per-config setting and `targetSource` names it.
async function inScope<T>(user: { id: string }, fn: () => Promise<T>): Promise<T> {
  return withUser(user as { id: string; email: string }, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

// One shadow row in the guest's log, judged or not. `verdict is null` is the
// queued state §2 hands a visitor, which is exactly what the clone's blanking
// leaves behind.
async function shadowRow(i: number, verdict: string | null): Promise<string> {
  const [newQuery, matched] = SHADOW_TEXTS[i];
  const [row] = await admin<{ id: string }[]>`
    insert into semantic_cache_shadow
      (config_id, embedding_model, space, fingerprint, new_query, new_query_hash,
       matched_query, served_answer, sim, verdict, origin)
    values (${configId}, ${KEY_MODEL}, 'test-space', 'fp', ${newQuery}, ${sha256(newQuery)},
            ${matched}, 'an answer', 0.9, ${verdict}, 'traffic')
    returning id`;
  return row.id;
}

const progressRow = () =>
  admin<{ payload: { generated: number; screened: boolean } }[]>`
    select payload from demo_replay
     where user_id = ${guest.id} and kind = 'progress'`;

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

// The minimum workspace the replay's reads walk: a guest profile, one config to
// scope the target and the shadow log, and the banked matrix itself. `is_guest`
// is set directly because lib/demo/guest reads exactly that column.
beforeEach(async () => {
  await truncateAll(admin);
  // The matrix is memoised per process and per user (see readMatrix), and the
  // ids are recycled by truncate — so a stale entry would serve the last test's
  // matrix to this one's guest. Every kind memoises the same way, so all four
  // of the Eval tab's shelves are dropped with it.
  forgetMatrix();
  forgetBoard();
  forgetRankings();
  forgetTuning();
  guest = await createUser(admin);
  real = await createUser(admin);
  await admin`
    update user_profiles set is_guest = true, expires_at = now() + interval '2 hours'
     where id = ${guest.id}`;

  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('demo corpus', ${guest.id}) returning id`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${guest.id}, ${corpus.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  configId = cfg.id;
  // In the OWNER's scope, which is where the publish writes it: `sql` refuses to
  // run outside one, and a write that needed a privileged client would be a
  // different statement from the one clone step 5g performs.
  await withUser(guest, () => writeMatrix(guest.id, matrix()));
});

describe("advanceReplay", () => {
  it("walks any n, persists it, and continues from where it stopped", async () => {
    const first = await inScope(guest, () => advanceReplay(1));
    assert.equal(first?.revealed, 1);
    assert.equal(first?.remaining, 3);
    assert.equal(first?.bank.total, 1);
    assert.deepEqual((await progressRow())[0].payload, { generated: 1, screened: false });

    const second = await inScope(guest, () => advanceReplay(2));
    assert.equal(second?.revealed, 2);
    assert.equal(second?.bank.total, 3);
    assert.equal(second?.remaining, 1);
    assert.deepEqual((await progressRow())[0].payload, { generated: 3, screened: false });
  });

  it("clamps at the end of the matrix rather than refusing", async () => {
    await inScope(guest, () => advanceReplay(3));
    const past = await inScope(guest, () => advanceReplay(99));
    // Asked for 99, moved by 1: the number the panel prints is the number that
    // moved, which is the discipline every count on this page holds.
    assert.equal(past?.requested, 99);
    assert.equal(past?.revealed, 1);
    assert.equal(past?.remaining, 0);
    assert.equal(past?.bank.total, 4);

    const exhausted = await inScope(guest, () => advanceReplay(5));
    assert.equal(exhausted?.revealed, 0);
    assert.equal(exhausted?.bank.total, 4);
  });
});

describe("screenReplay", () => {
  it("resolves the quarantine over the pairs reached, and the pool shrinks", async () => {
    await inScope(guest, () => advanceReplay(4));
    const before = await inScope(guest, () => replaySweepResult());
    // Unscreened: the quarantined pair is scored under the generator's label,
    // which is what unscreened MEANS.
    assert.equal(before?.pairs.generated, 4);

    const screened = await inScope(guest, () => screenReplay());
    assert.deepEqual(screened, { resolved: 4, quarantined: 1, remaining: 0 });
    assert.deepEqual((await progressRow())[0].payload, { generated: 4, screened: true });

    const after = await inScope(guest, () => replaySweepResult());
    assert.equal(after?.pairs.generated, 3);
    assert.equal((await inScope(guest, () => replayBankCounts()))?.quarantined, 1);
  });

  it("is idempotent — a second press resolves nothing and says so", async () => {
    await inScope(guest, () => advanceReplay(4));
    await inScope(guest, () => screenReplay());
    assert.equal((await inScope(guest, () => screenReplay()))?.resolved, 0);
  });
});

describe("the shadow half of the pool", () => {
  it("is the guest's own judged rows, joined to the matrix by pair identity", async () => {
    await inScope(guest, () => advanceReplay(4));
    // A queued row — no verdict — is not in the pool: there is nothing to score
    // it as.
    await shadowRow(0, null);
    assert.equal((await inScope(guest, () => replaySweepResult()))?.pairs.shadow, 0);

    await admin`update semantic_cache_shadow set verdict = 'accept'`;
    const judged = await inScope(guest, () => replaySweepResult());
    assert.equal(judged?.pairs.shadow, 1);
    assert.equal(judged?.pairs.total, 5);
  });

  it("moves the leaderboard when a verdict is handed down", async () => {
    await inScope(guest, () => advanceReplay(4));
    await inScope(guest, () => screenReplay());
    await shadowRow(0, "accept");
    await shadowRow(1, "reject");
    const both = await inScope(guest, () => replaySweepResult());
    const row = both!.rows.find((r) => r.model === KEY_MODEL)!;
    assert.equal(row.pairsScored, 5);
    assert.equal(row.samePairs, 2);
    assert.equal(row.differentPairs, 3);

    // The SAME rows under the opposite verdict score differently — the replay is
    // re-derived per request, not banked per build.
    await admin`update semantic_cache_shadow set verdict = 'reject'`;
    const flipped = await inScope(guest, () => replaySweepResult());
    assert.equal(flipped!.rows.find((r) => r.model === KEY_MODEL)!.samePairs, 1);
  });

  it("ignores a judged row the matrix has no cosine for", async () => {
    await inScope(guest, () => advanceReplay(4));
    await admin`
      insert into semantic_cache_shadow
        (config_id, embedding_model, space, fingerprint, new_query, new_query_hash,
         matched_query, served_answer, sim, verdict, origin)
      values (${configId}, ${KEY_MODEL}, 'test-space', 'fp', 'a question nobody banked',
              ${sha256("a question nobody banked")}, 'nor this one', 'an answer', 0.9,
              'accept', 'traffic')`;
    // Scoring it would mean inventing a similarity, which is the single thing the
    // replay must never do.
    assert.equal((await inScope(guest, () => replaySweepResult()))?.pairs.shadow, 0);
  });
});

describe("the pair-bank collision floor", () => {
  it("is the max cosine among the hard negatives reached, under the key model", async () => {
    await inScope(guest, () => advanceReplay(4));
    await inScope(guest, () => screenReplay());
    assert.deepEqual(await inScope(guest, () => replayPairsFloor(KEY_MODEL)), {
      floor: 0.4,
      comparisons: 2,
      missingVectors: 0,
    });
  });

  it("subsets with n like every other number on the page", async () => {
    await inScope(guest, () => advanceReplay(1));
    assert.deepEqual(await inScope(guest, () => replayPairsFloor(KEY_MODEL)), {
      floor: null,
      comparisons: 0,
      missingVectors: 0,
    });
  });
});

describe("a real account", () => {
  it("gets null from every entry point, so its own path is untouched", async () => {
    // The matrix is written under the REAL account here: the carve-out is being a
    // guest, not the absence of a row — the operator's own workspace owns the
    // matrix it captured, and serving it back would be a measurement implying a
    // computation that did not happen.
    await admin`update configs set user_id = ${real.id} where id = ${configId}`;
    await withUser(real, () => writeMatrix(real.id, matrix()));
    await inScope(real, async () => {
      assert.equal(await replayBankCounts(), null);
      assert.equal(await advanceReplay(5), null);
      assert.equal(await screenReplay(), null);
      assert.equal(await replaySweepResult(), null);
      assert.equal(await replayPairsFloor(KEY_MODEL), null);
    });
    // And nothing was written on their behalf.
    assert.equal((await admin`select 1 from demo_replay where kind = 'progress'`).length, 0);
  });

  it("is what a guest whose build banked no matrix looks like too", async () => {
    await admin`delete from demo_replay where user_id = ${guest.id}`;
    forgetMatrix();
    await inScope(guest, async () => {
      assert.equal(await replayBankCounts(), null);
      assert.equal(await advanceReplay(5), null);
      assert.equal(await replaySweepResult(), null);
    });
  });
});

// --- phase 4: the judge that doesn't call a judge ---------------------------
//
// The bulk pass over the queue is the last paid step on this page, and it is the
// one whose replay has a rule the others do not: a HUMAN verdict outranks it.
// What is asserted is the causal chain the plan turns on — a banked answer lands
// on the guest's own row, the leaderboard moves because of it, and the visitor's
// own decision is never overwritten by the operator's.
describe("replayJudgeQueue", () => {
  const bank = (ids: Record<string, "accept" | "reject">) =>
    withUser(guest, () =>
      writeShadowVerdicts(
        guest.id,
        new Map(
          Object.entries(ids).map(([id, verdict]) => [
            id,
            { verdict, judge_source: "llm", judge_model: "banked-judge", judge_reason: "because" },
          ]),
        ),
      ),
    );

  const judge = () =>
    inScope(guest, () => replayJudgeQueue({ space: "test-space", model: "some-judge-model" }));

  it("applies the operator's own verdicts, spending nothing", async () => {
    const queued = await shadowRow(0, null);
    await bank({ [queued]: "accept" });

    const run = await judge();
    assert.deepEqual(run, {
      judged: 1,
      accepted: 1,
      rejected: 0,
      skipped: 0,
      // The model REPORTED is the one that produced the verdict, not the one the
      // request happened to name: the panel prints it, and printing the visitor's
      // selection would claim a call that never went out.
      model: "banked-judge",
    });
    const [row] = await admin<{ verdict: string; judge_model: string; judge_reason: string }[]>`
      select verdict, judge_model, judge_reason from semantic_cache_shadow where id = ${queued}`;
    assert.deepEqual(row, { verdict: "accept", judge_model: "banked-judge", judge_reason: "because" });
  });

  it("moves the leaderboard, which is the whole point of the queue", async () => {
    await inScope(guest, () => advanceReplay(4));
    await inScope(guest, () => screenReplay());
    const queued = await shadowRow(0, null);
    assert.equal((await inScope(guest, () => replaySweepResult()))?.pairs.shadow, 0);

    await bank({ [queued]: "accept" });
    await judge();
    const after = await inScope(guest, () => replaySweepResult());
    assert.equal(after?.pairs.shadow, 1);
    assert.equal(after?.rows.find((r) => r.model === KEY_MODEL)!.pairsScored, 4);
  });

  it("never overwrites a verdict the visitor reached themselves", async () => {
    const own = await shadowRow(0, "reject");
    await admin`update semantic_cache_shadow set judge_source = 'human' where id = ${own}`;
    // Banked the OPPOSITE answer, so a silent overwrite would be visible.
    await bank({ [own]: "accept" });

    // A bulk pass does not even look at it (it is judged), and a boundary re-judge
    // looks and refuses.
    assert.equal((await judge())?.judged, 0);
    await inScope(guest, () =>
      replayJudgeQueue({ space: "test-space", model: "some-judge-model", rejudge: true }),
    );
    const [row] = await admin<{ verdict: string }[]>`
      select verdict from semantic_cache_shadow where id = ${own}`;
    assert.equal(row.verdict, "reject");
  });

  it("skips a queued row nothing was banked for rather than inventing one", async () => {
    const orphan = await shadowRow(1, null);
    const run = await judge();
    assert.deepEqual(run, {
      judged: 0,
      accepted: 0,
      rejected: 0,
      skipped: 1,
      // Nothing banked, so there is no model to name and the request's own is the
      // only honest fallback.
      model: "some-judge-model",
    });
    assert.equal(
      (await admin`select 1 from semantic_cache_shadow where id = ${orphan} and verdict is null`)
        .length,
      1,
    );
  });

  it("returns null for a real account, so their pass still costs what it costs", async () => {
    await admin`update configs set user_id = ${real.id} where id = ${configId}`;
    await inScope(real, async () => {
      assert.equal(await replayJudgeQueue({ space: "test-space", model: "m" }), null);
    });
  });
});

// --- phase 8: the Eval tab's four kinds, from the carve-out's end ------------
//
// The rails for docs/demo-real-flow-plan.md. Its four new `demo_replay` kinds
// (`board`, `ndcg_ideal`, `llm_ranking`, `tuning`) are what let a guest press
// "Add nDCG rankings", "Add LLM nDCG rankings" and ⚙ Auto tune without spending
// anything, and every one of those carve-outs is written the same way: read the
// shelf, and gate only when it is empty. That inverts the usual failure — a
// reader that answered a REAL account with a payload would not refuse them, it
// would serve them the master's banked measurement in place of the computation
// they asked for and paid for.
//
// scripts/guards.ts sweep 6c asserts the guard is in each function's source;
// this asserts it is TRUE against a real database, with the kinds stocked under
// the real account's own id — which is the case a missing row would hide.
describe("the Eval tab's banked kinds", () => {
  const QUESTION = "what is the fee?";
  const BOARD: ReplayBoard = { version: 1, chunks: ["chunk-a", "chunk-b"] };
  const ideals: ReplayRankings = {
    version: 1,
    entries: [{ q: questionIdentity(QUESTION), order: ["chunk-b", "chunk-a"] }],
  };
  const llm: ReplayRankings = {
    version: 1,
    // A null holds a rank that failed the clone's remap — the shape the reader
    // has to hand back untouched, since position is the measurement.
    entries: [{ q: questionIdentity(QUESTION), order: ["chunk-a", null] }],
  };
  const tuning: ReplayTuning = {
    version: 1,
    entries: [
      {
        chunk: "chunk-a",
        model: KEY_MODEL,
        kind: "model",
        detail: "re-embedded under the trial model",
        pieces: [
          {
            text: null,
            dimension: 2,
            // Exactly representable in float32, so a round-trip that loses
            // precision is a failure rather than a rounding argument.
            embedding: packEmbedding([0.5, -0.25]),
            tokenStart: null,
            tokenEnd: null,
          },
        ],
        trials: [],
      },
    ],
  };

  // In the OWNER's scope, which is where the publish and the clone write: `sql`
  // refuses to run outside one.
  const stock = (owner: { id: string; email: string }) =>
    withUser(owner, async () => {
      await writeBoard(owner.id, BOARD);
      await writeIdeals(owner.id, ideals);
      await writeLlmRankings(owner.id, llm);
      await writeTuning(owner.id, tuning);
    });

  it("a guest reads all four back, byte-for-byte", async () => {
    await stock(guest);
    await inScope(guest, async () => {
      assert.deepEqual(await readBoard(), BOARD);
      assert.deepEqual(
        (await readIdeals())?.get(questionIdentity(QUESTION)),
        ["chunk-b", "chunk-a"],
      );
      assert.deepEqual(
        (await readLlmRankings())?.get(questionIdentity(QUESTION)),
        ["chunk-a", null],
      );
      const banked = await readTuning();
      assert.equal(banked?.entries[0].chunk, "chunk-a");
      assert.deepEqual(unpackEmbedding(banked!.entries[0].pieces[0].embedding), [0.5, -0.25]);
    });
  });

  it("a real account reads null from each, however stocked its own workspace is", async () => {
    // Stocked under the REAL account: the carve-out is being a guest, not the
    // absence of a row. The operator's workspace is the one that captured these.
    await admin`update configs set user_id = ${real.id} where id = ${configId}`;
    await stock(real);
    await inScope(real, async () => {
      assert.equal(await readBoard(), null);
      assert.equal(await readIdeals(), null);
      assert.equal(await readLlmRankings(), null);
      assert.equal(await readTuning(), null);
    });
  });

  it("is the same null for a guest whose build banked none of them", async () => {
    await admin`
      delete from demo_replay
       where user_id = ${guest.id} and kind in ('board', 'ndcg_ideal', 'llm_ranking', 'tuning')`;
    forgetBoard();
    forgetRankings();
    forgetTuning();
    await inScope(guest, async () => {
      assert.equal(await readBoard(), null);
      assert.equal(await readIdeals(), null);
      assert.equal(await readLlmRankings(), null);
      assert.equal(await readTuning(), null);
    });
  });
});
