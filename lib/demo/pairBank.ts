// THE PAIR BANK — phases 3 and 3b of docs/demo-cache-lab-plan.md.
//
// SUPERSEDED, AND WAITING ON ONE THING. Phase 3 of docs/demo-cache-replay-plan.md
// moved both carve-outs below onto the banked similarity matrix, so nothing in a
// route calls this module any more: the demo ships the SIMILARITIES now, and a
// reveal that inserted pair rows would be handing a guest inputs whose numbers
// the leaderboard no longer reads. What keeps the module (and 0078, and clone
// step 5e) alive for the moment is the single probe, which is the one live thing
// left that needs real pair TEXT to embed. It goes in the copy pass, and this
// goes with it.
//
// §4's two remaining buttons, "Generate pairs" and the LLM pair screen, both buy
// answer-model tokens the demo carries no key for. Neither is ungatable and
// neither is worth leaving dead, because the ANSWER to both already exists: the
// operator generated those pairs and F3 audited them, and lib/demo/clone banks a
// capped sample of that work in `demo_pair_bank` (0078) at publish time.
//
// So this module is the reveal side of that publish. It is the same carve-out
// `cachedOnly` makes on /api/eval/bulk-generate — the reveal is REAL (rows land
// in semantic_cache_pairs and every reader downstream sees them), the WRITING is
// what is skipped — and it is deliberately the only thing here: nothing in this
// file calls a model, an embedder, or a provider.
//
// THE TWO HALVES ARE ONE MECHANISM SEEN TWICE. A banked `kind='pair'` row is a
// whole pair the guest has not been handed; a banked `kind='verdict'` row is the
// five verdict columns (0070) the clone blanked on a pair they WERE handed, so
// that the panel's "unscreened" count means something and pressing screen
// resolves it to F3's audited answer instead of to a guess. Revealing a pair
// creates the second kind out of the first: the pair goes in blanked and its
// verdict goes back on the shelf, so a revealed pair and a cloned one reach the
// screen button in identical condition and it cannot tell them apart.
//
// BOTH ARE NO-OPS FOR A REAL ACCOUNT, and they say so by returning null rather
// than an empty result. The callers use that null to fall through to the ordinary
// gated path (see app/api/semantic-cache/pairs and app/api/batch/submit): a
// carve-out that returned a zero-count result to everyone would silently swallow
// a real account's generate.
//
// NULL ALSO MEANS "THIS BUILD PUBLISHED NO ANSWER", which is readPublishedSweep's
// null exactly. A guest whose workspace carries neither a bank nor a single pair
// was cloned from a master that never generated any, and the honest response to
// their click is DEMO_ACTIONS.pairs — the fallback sentence lib/demo/policy keeps
// for precisely that build — not a cheerful "revealed 0 of 0". The distinguishing
// question is whether any pairs exist at all: a DRAINED bank sits above a table
// full of revealed rows, an unpublished one above an empty table.
import "server-only";

import type postgres from "postgres";

import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { isGuest } from "@/lib/demo/guest";
import { pairInsert, verdictOf, type BankedPairPayload, type BankedVerdictPayload } from "@/lib/demo/pairBankCore";
import { expectedVerdict, type PairLabel } from "@/lib/rag/semanticCachePairs";

// What a reveal did, in the terms the panel reports it: how many pairs LANDED,
// how many were asked for, and how much of the bank is left to uncover.
export type PairReveal = {
  revealed: number;
  requested: number;
  remaining: number;
};

// What the screen resolved. `quarantined` is the number the panel actually
// prints, because that is what the screen is FOR: a verdict that contradicts the
// generator's label is a pair the sweep must stop scoring (F3 proved 15 of them
// mislabelled), and "we filled in some verdicts" is not the story.
export type BankedScreen = {
  resolved: number;
  quarantined: number;
  remaining: number;
};

// A ceiling on one reveal, independent of whatever the caller's slider allows.
// It sits far above what any publish banks — lib/demo/frozen's PAIR_BANK_CAP is
// 20 — so it can only bite if that cap grows by an order of magnitude, and it is
// deliberately NOT that constant: this bounds one TRANSACTION, and a request that
// inserted thousands of rows would hold a pooled connection for the whole of it
// (lib/db's "WHY A TRANSACTION PER SCOPE"), whichever number the clone chose.
const REVEAL_MAX = 500;

// Same 42P01 tolerance semanticCachePairs holds for its own table, for the same
// reason and one table further along: a build deployed before 0078 has no bank,
// which is not an error condition — it is a workspace published without one, and
// it takes the same path as a drained one.
const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// Wrapped rather than try/caught at each call site so the two reveal paths cannot
// disagree about what a missing bank means: it is the same null as an unpublished
// one, and the caller's gate says the rest.
const withoutBank = <T>(work: Promise<T>): Promise<T | null> =>
  work.catch((err: unknown) => {
    if (isMissingTable(err)) return null;
    throw err;
  });

// Does this account hold any pairs at all? Only asked when the bank came up
// empty, to separate "you have revealed everything" from "nothing was ever
// published here" — see the module header. Scoped through the ownership join
// pairStats uses, so the two agree about what counts as this user's pair.
async function anyPairs(tx: postgres.TransactionSql, userId: string): Promise<boolean> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from semantic_cache_pairs p
      join eval_questions q on q.id = p.origin_question_id
      join documents d on d.id = q.document_id
     where d.user_id = ${userId}
  `;
  return (row?.n ?? 0) > 0;
}

// Hand the guest up to `n` banked pairs.
//
// IDEMPOTENT UNDER A DOUBLE-CLICK, by two mechanisms that answer two different
// races. `for update skip locked` means a second in-flight request takes the NEXT
// rows rather than the same ones, so two clicks reveal two batches instead of one
// batch twice; the pair table's own `on conflict do nothing` (0050's
// `unique (origin_question_id, hash_a, hash_b)`) means a pair that is somehow
// already present is not duplicated. One transaction, so a failure anywhere
// leaves the bank exactly as full as it was.
//
// COUNTED FROM THE INSERT, NOT FROM THE INTENT. `revealed` is how many rows the
// insert actually returned, which is the same discipline clone step 5b's `queued`
// count learned the hard way: a dedupe can drop a row the pick list contained,
// and a count that reported what we MEANT to do would be the one number on the
// panel nobody could check against the table.
export async function revealBankedPairs(n: number): Promise<PairReveal | null> {
  if (!(await isGuest())) return null;
  const userId = activeUserId();
  const take = Math.min(Math.max(Math.trunc(n), 0), REVEAL_MAX);
  return withoutBank(sql.begin(async (tx) => {
    const banked = take === 0
      ? []
      : await tx<{ id: string; payload: BankedPairPayload }[]>`
          select id, payload
            from demo_pair_bank
           where user_id = ${userId} and kind = 'pair'
           order by created_at, id
           limit ${take}
             for update skip locked
        `;
    let revealed = 0;
    for (const row of banked) {
      const p = pairInsert(row.payload);
      // BLANKED ON THE WAY IN — phase 3b's whole design. The verdict columns are
      // written null here even though the payload carries real ones, and re-banked
      // below as a `kind='verdict'` row. Insert them directly and the pair arrives
      // pre-screened: pairStats' `unjudged` never counts it, the screen button has
      // nothing to resolve, and the audited answer is delivered as a fait accompli
      // rather than as the thing the guest pressed a button to see.
      const [inserted] = await tx<{ id: string }[]>`
        insert into semantic_cache_pairs
          (origin_question_id, text_a, text_b, hash_a, hash_b, label, difficulty, generated_by,
           verdict, verdict_source, judge_model, judge_reason, judged_at)
        values
          (${p.originQuestionId}, ${p.textA}, ${p.textB}, ${p.hashA}, ${p.hashB},
           ${p.label}, ${p.difficulty}, ${p.generatedBy},
           null, null, null, null, null)
        on conflict (origin_question_id, hash_a, hash_b) do nothing
        returning id
      `;
      if (!inserted) continue;
      revealed++;
      const verdict = verdictOf(row.payload);
      if (verdict) {
        await tx`
          insert into demo_pair_bank (user_id, kind, pair_id, payload)
          values (${userId}, 'verdict', ${inserted.id}, ${tx.json(verdict as never)})
        `;
      }
    }
    // Every row this transaction took is consumed, INCLUDING one whose insert hit
    // the conflict: that pair is already in the guest's table, so leaving it
    // banked would offer to reveal a pair they can already see, forever.
    if (banked.length > 0) {
      await tx`
        delete from demo_pair_bank
         where user_id = ${userId} and id = any(${banked.map((r) => r.id)}::uuid[])
      `;
    }
    const [rest] = await tx<{ n: number }[]>`
      select count(*)::int as n
        from demo_pair_bank
       where user_id = ${userId} and kind = 'pair'
    `;
    const remaining = rest?.n ?? 0;
    // Nothing taken, nothing left, and no pairs anywhere: this build published no
    // pair bank, so the caller falls through to the gate and the visitor reads
    // DEMO_ACTIONS.pairs. See the module header — the alternative is a 200 that
    // reports revealing nothing out of nothing, which describes a working feature
    // with no content and a missing feature identically.
    if (revealed === 0 && remaining === 0 && !(await anyPairs(tx, userId))) return null;
    return { revealed, requested: take, remaining };
  }));
}

// Resolve every blanked verdict the publish banked — the guest's "screen" button.
//
// Not limited or paged, unlike the reveal: the screen is one pass over the
// unscreened set on a real account too (see unscreenedPairs' 5,000 default), the
// bank is capped by the clone, and a screen that resolved half the rows would
// leave the panel reporting an unscreened count that a second press would change
// for reasons no visitor could infer.
export async function applyBankedVerdicts(): Promise<BankedScreen | null> {
  if (!(await isGuest())) return null;
  const userId = activeUserId();
  return withoutBank(sql.begin(async (tx) => {
    const banked = await tx<
      { id: string; pair_id: string; payload: BankedVerdictPayload }[]
    >`
      select id, pair_id, payload
        from demo_pair_bank
       where user_id = ${userId} and kind = 'verdict' and pair_id is not null
       order by created_at, id
         for update skip locked
    `;
    let resolved = 0;
    let quarantined = 0;
    for (const row of banked) {
      // setPairVerdict's rule, held here rather than borrowed, because this write
      // needs `returning` and that function returns void: a HUMAN verdict is final
      // and an LLM pass never overwrites one. It matters more here than there —
      // §3 hands a guest an Accept/Reject queue, so a pair they adjudicated
      // themselves is exactly the row this would otherwise silently overrule.
      const [updated] = await tx<{ label: PairLabel; verdict: "accept" | "reject" }[]>`
        update semantic_cache_pairs
           set verdict = ${row.payload.verdict},
               verdict_source = ${row.payload.verdict_source ?? "llm"},
               judge_model = ${row.payload.judge_model ?? null},
               judge_reason = ${row.payload.judge_reason ?? null},
               judged_at = ${row.payload.judged_at ?? new Date()}
         where id = ${row.pair_id}
           and verdict_source is distinct from 'human'
        returning label, verdict
      `;
      if (!updated) continue;
      resolved++;
      // The quarantine, computed the one way the app computes it (expectedVerdict
      // is the single place the pair table's labels and the judge's verdicts are
      // tied together). Deriving it here from what LANDED rather than trusting a
      // banked flag keeps this number and pairStats' `quarantined` — which counts
      // the same contradiction in SQL — from being able to disagree.
      if (updated.verdict !== expectedVerdict(updated.label)) quarantined++;
    }
    // Consumed either way, a skipped human-adjudicated row included: its verdict
    // is settled by someone with more authority than this, and a bank row that can
    // never be applied is a screen button that never reaches zero.
    if (banked.length > 0) {
      await tx`
        delete from demo_pair_bank
         where user_id = ${userId} and id = any(${banked.map((r) => r.id)}::uuid[])
      `;
    }
    const [rest] = await tx<{ n: number }[]>`
      select count(*)::int as n
        from demo_pair_bank
       where user_id = ${userId} and kind = 'verdict'
    `;
    const remaining = rest?.n ?? 0;
    // The same "no published answer" null the reveal returns, and the same test:
    // a guest with pairs but no banked verdicts has screened everything there was
    // to screen; one with neither was cloned from a build that banked none, and
    // owes the visitor the gate's sentence rather than a resolved count of zero.
    if (resolved === 0 && remaining === 0 && !(await anyPairs(tx, userId))) return null;
    return { resolved, quarantined, remaining };
  }));
}

// How much is left on the shelf, for a panel that wants to say so before anything
// is pressed. Null for a real account, like the two above and for the same
// reason: "0 banked pairs" is a true statement that would read as a broken
// feature on an account that never had a bank.
export async function bankCounts(): Promise<{ pairs: number; verdicts: number } | null> {
  if (!(await isGuest())) return null;
  const rows = await sql<{ kind: string; n: number }[]>`
    select kind, count(*)::int as n
      from demo_pair_bank
     where user_id = ${activeUserId()}
     group by kind
  `;
  return {
    pairs: rows.find((r) => r.kind === "pair")?.n ?? 0,
    verdicts: rows.find((r) => r.kind === "verdict")?.n ?? 0,
  };
}
