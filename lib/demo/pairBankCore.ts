// THE PAIR BANK'S PAYLOAD SHAPE — phases 3 and 3b of docs/demo-cache-lab-plan.md.
//
// `demo_pair_bank.payload` (0078) is jsonb written by one process (the clone) and
// read by another (the reveal), which is exactly the seam where a field silently
// stops being written and nothing notices until a guest's §4 is short a column.
// So the two halves of the payload — the pair's own columns, and the five verdict
// columns 0070 added — get one module that names them.
//
// SPLIT OUT OF pairBank.ts FOR THE REASON publishedSweepCore IS SPLIT OUT OF
// publishedSweep: this half touches no database and no request scope, so it is
// unit-testable on its own, while the half that opens a transaction is not.
// Nothing here imports "server-only" or lib/db, and it should stay that way.
//
// The keys are SNAKE_CASE because the payload is a row: lib/demo/clone builds it
// with the pair table's own column names, and a payload that renamed them on the
// way in would need renaming again on the way out for no gain.
import { createHash } from "node:crypto";

// What the clone banks for `kind='pair'` — the insertable columns of
// semantic_cache_pairs, `origin_question_id` already remapped to the guest's own
// question (0078's header explains why that remap happens on the way IN), and no
// `id`, since the reveal's insert mints one.
export type BankedPairPayload = {
  origin_question_id: string;
  text_a: string;
  text_b: string;
  label: string;
  difficulty: string;
  generated_by: string;
  // Present but NOT used by the reveal: the reveal blanks these on the way into
  // the pair table and re-banks them as a `kind='verdict'` row, so that pressing
  // "Screen pairs" has something audited to resolve to. See revealBankedPairs.
  verdict?: string | null;
  verdict_source?: string | null;
  judge_model?: string | null;
  judge_reason?: string | null;
  judged_at?: string | null;
};

// What the clone banks for `kind='verdict'` — the five columns it blanked on a
// pair it DID hand over. Identical field-for-field to the tail of the pair
// payload above, deliberately: a revealed pair's verdict and a cloned pair's
// verdict are the same thing arriving by two routes, and the screen must not be
// able to tell them apart.
export type BankedVerdictPayload = {
  verdict: string;
  verdict_source?: string | null;
  judge_model?: string | null;
  judge_reason?: string | null;
  judged_at?: string | null;
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

// The columns an insert into semantic_cache_pairs needs, in the CANONICAL
// orientation, verdicts excluded.
export type PairInsert = {
  originQuestionId: string;
  textA: string;
  textB: string;
  hashA: string;
  hashB: string;
  label: string;
  difficulty: string;
  generatedBy: string;
};

// RE-DERIVED FROM THE TEXTS, NOT COPIED FROM THE PAYLOAD, even though the payload
// carries hash_a/hash_b. The hashes are not data, they are a function of the text
// — and they are also the dedupe key (0050 made it
// `unique (origin_question_id, hash_a, hash_b)`), so a payload whose hash and
// text ever disagreed would insert a row that no later generate could match and
// no reveal could re-detect as already present. Recomputing costs two sha256s a
// pair and removes that class of drift entirely.
//
// The orientation rule is insertPairs' rule, character for character (lower hash
// first): the label is symmetric, so orientation carries no information, and a
// row stored under the other order is a duplicate the unique key cannot see.
// These are the same two texts a real generate would have written, so a revealed
// pair and a generated one collide exactly where they should.
export function pairInsert(payload: BankedPairPayload): PairInsert {
  const ha = sha256(payload.text_a);
  const hb = sha256(payload.text_b);
  const flip = hb < ha;
  return {
    originQuestionId: payload.origin_question_id,
    textA: flip ? payload.text_b : payload.text_a,
    textB: flip ? payload.text_a : payload.text_b,
    hashA: flip ? hb : ha,
    hashB: flip ? ha : hb,
    label: payload.label,
    difficulty: payload.difficulty,
    generatedBy: payload.generated_by,
  };
}

// The verdict half of a `kind='pair'` payload, as a `kind='verdict'` payload.
// Returns null when the banked pair carried no verdict: an unscreened pair is a
// legitimate thing to bank (the master screens inline but the batch path does
// not), and banking a verdict of `null` would give the guest a screen button that
// resolves rows to nothing while claiming to have audited them.
export function verdictOf(payload: BankedPairPayload): BankedVerdictPayload | null {
  if (!payload.verdict) return null;
  return {
    verdict: payload.verdict,
    verdict_source: payload.verdict_source ?? null,
    judge_model: payload.judge_model ?? null,
    judge_reason: payload.judge_reason ?? null,
    judged_at: payload.judged_at ?? null,
  };
}
