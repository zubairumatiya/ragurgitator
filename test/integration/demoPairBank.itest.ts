// THE PAIR BANK'S TWO REVEALS, against a real database — phases 3 and 3b of
// docs/demo-cache-lab-plan.md.
//
// lib/demo/pairBankCore.test.ts covers the payload→row translation, which is the
// half that is a pure function. Everything that makes the reveal a FEATURE is the
// half a unit test cannot reach: a transaction, a unique constraint, RLS, and
// three counts that have to agree with pairStats' SQL.
//
// What is asserted here, and why each one is a real failure mode rather than a
// tautology:
//
//   1. A REVEALED PAIR ARRIVES BLANKED. Phase 3b's whole design is that the guest
//      presses screen and gets F3's audited answer; a reveal that carried the
//      verdict in with the pair would deliver it unasked and leave the button
//      with nothing to do — and nothing would error.
//   2. THE COUNT COMES FROM THE INSERT. Clone step 5b's `queued` count learned
//      this: a dedupe drops rows a pick list contained, so a reveal that counted
//      its intent would report pairs the table does not hold.
//   3. THE SCREEN RESOLVES TO THE AUDITED ANSWER, quarantine included, and
//      pairStats agrees with it — the panel prints one of those numbers beside
//      the other.
//   4. A HUMAN VERDICT SURVIVES. §3 hands a guest an Accept/Reject queue, so a
//      pair they adjudicated themselves is exactly the row a banked LLM verdict
//      would otherwise overrule.
//   5. BOTH ARE NULL FOR A REAL ACCOUNT. That null is what the two routes' gates
//      hang on; if it ever became a zero-count result, a real account's generate
//      would be silently swallowed by the demo's carve-out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { withUser } from "../../lib/auth/userScope";
import { config } from "../../lib/config";
import { fragment, privilegedSql } from "../../lib/db";
import { applyBankedVerdicts, revealBankedPairs } from "../../lib/demo/pairBank";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";
import { pairStats } from "../../lib/rag/semanticCachePairs";
import { adminClient, createUser, ensureAppRole, truncateAll } from "../support/harness";

type Sql = ReturnType<typeof adminClient>;

const KEY_MODEL = config.semanticCache.keyModel;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

let admin: Sql;
let guest: { id: string; email: string };
let real: { id: string; email: string };
let configId: string;
let questionId: string;

// A bank payload as clone step 5e writes it: `to_jsonb(row) - 'id'`, so the
// verdict columns ride along and the reveal is the thing that strips them.
const payload = (over: Record<string, unknown> = {}) => ({
  origin_question_id: questionId,
  text_a: "origin question?",
  text_b: "the variant?",
  hash_a: sha256("origin question?"),
  hash_b: sha256("the variant?"),
  label: "same",
  difficulty: "paraphrase",
  generated_by: "claude-haiku-4-5",
  verdict: "accept",
  verdict_source: "llm",
  judge_model: "claude-sonnet-4-5",
  judge_reason: "one answer serves both",
  judged_at: "2026-08-17T00:00:00.000Z",
  created_at: "2026-08-17T00:00:00.000Z",
  ...over,
});

async function bankPair(userId: string, over: Record<string, unknown> = {}) {
  await admin`
    insert into demo_pair_bank (user_id, kind, payload)
    values (${userId}, 'pair', ${admin.json(payload(over))})`;
}

// Everything the reveal touches runs inside a user scope, and pairStats also
// needs a config (its `gap` is config-scoped by design — see its comment on
// whose gap it reports).
async function inScope<T>(user: { id: string }, fn: () => Promise<T>): Promise<T> {
  return withUser(user as { id: string; email: string }, async () => {
    const cfg = await resolveConfig(configId);
    assert.ok(cfg, "config fixture did not resolve");
    return withConfig(cfg, fn);
  });
}

// The two bank functions never read the active config, so a scope check on a
// user who owns no config is a plain user scope. Using inScope() here would fail
// on resolveConfig long before reaching the thing under test.
const asUser = <T>(user: { id: string; email: string }, fn: () => Promise<T>) =>
  withUser(user, fn);

const pairRows = () =>
  admin<{ id: string; verdict: string | null; verdict_source: string | null }[]>`
    select p.id, p.verdict, p.verdict_source
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
     where d.user_id = ${guest.id}
     order by p.text_b`;

const bankRows = (kind: "pair" | "verdict") =>
  admin<{ id: string; pair_id: string | null }[]>`
    select id, pair_id from demo_pair_bank
     where user_id = ${guest.id} and kind = ${kind}`;

before(async () => {
  admin = adminClient();
  await ensureAppRole(admin);
});

after(async () => {
  await admin?.end();
  await (fragment as unknown as { end: () => Promise<void> }).end();
  await privilegedSql.end();
});

// The minimum workspace the bank's ownership joins walk: a guest profile, one
// document, one config, one eval question. `is_guest` is set directly because
// lib/demo/guest reads exactly that column and nothing here is testing the
// provisioning path that writes it.
beforeEach(async () => {
  await truncateAll(admin);
  guest = await createUser(admin);
  real = await createUser(admin);
  await admin`
    update user_profiles set is_guest = true, expires_at = now() + interval '2 hours'
     where id = ${guest.id}`;

  const [corpus] = await admin<{ id: string }[]>`
    insert into corpora (name, user_id) values ('demo corpus', ${guest.id}) returning id`;
  const [doc] = await admin<{ id: string }[]>`
    insert into documents (file_name, content_hash, content, user_id)
    values ('a.txt', ${sha256("a")}, 'body', ${guest.id}) returning id`;
  await admin`
    insert into corpus_documents (corpus_id, document_id) values (${corpus.id}, ${doc.id})`;
  const [cfg] = await admin<{ id: string }[]>`
    insert into configs (user_id, corpus_id, base_model, chunk_size, chunk_overlap, top_k, llm_model)
    values (${guest.id}, ${corpus.id}, ${KEY_MODEL}, 500, 50, 5, 'test-llm') returning id`;
  configId = cfg.id;
  const [q] = await admin<{ id: string }[]>`
    insert into eval_questions (document_id, question, expected_answer)
    values (${doc.id}, 'origin question?', 'the answer') returning id`;
  questionId = q.id;
});

describe("revealBankedPairs", () => {
  it("lands the pair blanked and re-banks its verdict", async () => {
    await bankPair(guest.id);
    const result = await inScope(guest, () => revealBankedPairs(5));

    assert.deepEqual(result, { revealed: 1, requested: 5, remaining: 0 });
    const pairs = await pairRows();
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].verdict, null, "the reveal delivered F3's verdict unasked");
    assert.equal(pairs[0].verdict_source, null);

    const verdicts = await bankRows("verdict");
    assert.equal(verdicts.length, 1, "the audited verdict was thrown away, not re-banked");
    assert.equal(verdicts[0].pair_id, pairs[0].id, "the verdict points at another row");
    assert.equal((await bankRows("pair")).length, 0, "the consumed pair stayed on the shelf");
  });

  it("reveals no more than asked for, and reports what is left", async () => {
    for (const n of [1, 2, 3]) await bankPair(guest.id, { text_b: `variant ${n}?` });
    const first = await inScope(guest, () => revealBankedPairs(2));
    assert.deepEqual(first, { revealed: 2, requested: 2, remaining: 1 });
    assert.equal((await pairRows()).length, 2);

    const second = await inScope(guest, () => revealBankedPairs(2));
    assert.deepEqual(second, { revealed: 1, requested: 2, remaining: 0 });
    assert.equal((await pairRows()).length, 3, "the second press re-revealed the first two");
  });

  it("counts what LANDED, not what it took, when the pair is already there", async () => {
    // The same pair banked twice: 0050's unique (origin_question_id, hash_a,
    // hash_b) makes the second insert a no-op. A reveal that counted its pick list
    // would report two pairs over a table holding one.
    await bankPair(guest.id);
    await bankPair(guest.id);
    const result = await inScope(guest, () => revealBankedPairs(5));
    assert.equal(result?.revealed, 1);
    assert.equal((await pairRows()).length, 1);
    assert.equal((await bankRows("pair")).length, 0, "the duplicate stayed banked forever");
    assert.equal((await bankRows("verdict")).length, 1, "a verdict was banked for a row that did not land");
  });

  it("is a no-op under a double-click", async () => {
    for (const n of [1, 2]) await bankPair(guest.id, { text_b: `variant ${n}?` });
    const [a, b] = await Promise.all([
      inScope(guest, () => revealBankedPairs(2)),
      inScope(guest, () => revealBankedPairs(2)),
    ]);
    // `for update skip locked` means the two presses split the bank between them
    // rather than both revealing the same rows. Either way the table holds two.
    assert.equal((a?.revealed ?? 0) + (b?.revealed ?? 0), 2);
    assert.equal((await pairRows()).length, 2);
  });

  it("returns null for a real account, and for a guest with nothing published", async () => {
    await bankPair(real.id);
    assert.equal(await asUser(real, () => revealBankedPairs(5)), null);
    assert.equal(
      await inScope(guest, () => revealBankedPairs(5)),
      null,
      "an empty build must reach the gate's fallback sentence, not a 200",
    );
  });
});

describe("applyBankedVerdicts", () => {
  it("resolves the blanked verdicts and counts the new quarantine", async () => {
    // Two pairs, one of which F3 contradicted: label 'same' with verdict 'reject'
    // is precisely the mislabelling the screen exists to catch.
    await bankPair(guest.id, { text_b: "a true paraphrase?" });
    await bankPair(guest.id, { text_b: "not a paraphrase at all?", verdict: "reject" });
    await inScope(guest, () => revealBankedPairs(5));

    const before = await inScope(guest, () => pairStats());
    assert.equal(before.unjudged, 2, "revealed pairs must read as unscreened");
    assert.equal(before.quarantined, 0);

    const screened = await inScope(guest, () => applyBankedVerdicts());
    assert.deepEqual(screened, { resolved: 2, quarantined: 1, remaining: 0 });

    const after = await inScope(guest, () => pairStats());
    assert.equal(after.unjudged, 0);
    assert.equal(after.quarantined, 1, "pairStats and the screen disagree about the quarantine");
    assert.equal((await bankRows("verdict")).length, 0);
  });

  it("never overwrites a verdict the guest reached by hand", async () => {
    await bankPair(guest.id, { verdict: "reject" });
    await inScope(guest, () => revealBankedPairs(5));
    const [pair] = await pairRows();
    await admin`
      update semantic_cache_pairs
         set verdict = 'accept', verdict_source = 'human', judged_at = now()
       where id = ${pair.id}`;

    const screened = await inScope(guest, () => applyBankedVerdicts());
    // Not resolved, and not left on the shelf either: the row is settled by
    // someone with more authority than a banked LLM verdict, and a bank row that
    // can never be applied is a screen button that never reaches zero.
    assert.deepEqual(screened, { resolved: 0, quarantined: 0, remaining: 0 });
    assert.equal((await bankRows("verdict")).length, 0);
    const [after] = await pairRows();
    assert.equal(after.verdict, "accept");
    assert.equal(after.verdict_source, "human");
  });

  it("returns null for a real account", async () => {
    assert.equal(await asUser(real, () => applyBankedVerdicts()), null);
  });
});
