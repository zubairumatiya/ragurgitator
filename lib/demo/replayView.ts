// SERVING THE MATRIX — phase 3 of docs/demo-cache-replay-plan.md.
//
// The demo's Appraise → Semantic caching page used to ship INPUTS: a sample of
// the operator's pair rows plus a shelf of withheld ones, so a visitor's clicks
// performed real work over a corpus that was not the one the frozen leaderboard
// three lines below described. Four places print `n` on that page and three of
// them could not move.
//
// Under the matrix all four read off the same measurement. This module is the
// read side of it: every function here answers ONE panel's question by
// subsetting the banked cosines to what the visitor has reached and re-running
// the app's own arithmetic over them (lib/demo/replayViewCore). Nothing here
// embeds, judges, or calls a provider — the whole cost was paid at publish time,
// and what is left is a slice and a calibration.
//
// THE CARVE-OUT IS THE FUNCTION, the rule lib/demo/pairBank established and
// guards.ts sweep 6b pins: every read below returns null for anyone who is not a
// guest, because readMatrix does. So a route may call one unconditionally and
// still fail closed — a real account gets null, falls through to the ordinary
// path byte-for-byte as it is, and keeps its unconditional assertDemoAllows.
//
// NULL ALSO MEANS "THIS BUILD PUBLISHED NO MATRIX", which is readPublishedSweep's
// null exactly: a guest cloned from a master that never captured one gets the
// ordinary refusal and lib/demo/policy's sentence, not a cheerful zero.
import "server-only";

import { activeUserId } from "@/lib/auth/userScope";
import { sql } from "@/lib/db";
import { pairIdentity, type ReplayProgress } from "@/lib/demo/replayCore";
import { readMatrix, readProgress, readShadowVerdicts, writeProgress } from "@/lib/demo/replay";
import {
  replayPairFloor,
  replaySweep,
  selectReplay,
  type BankCounts,
  type ReplaySelection,
} from "@/lib/demo/replayViewCore";
import type { SweepResult } from "@/lib/rag/keyModelSweep";
import {
  JUDGE_DEFAULT_LIMIT,
  JUDGE_MAX_LIMIT,
  ownedConfigs,
  type JudgeRunResult,
} from "@/lib/rag/semanticCacheCalibration";
import type { PairLabelLike } from "@/lib/rag/keyModelSweepCore";
import type { ReplayMatrix } from "@/lib/demo/replayCore";
import { scopedAcceptTarget, type EffectiveAcceptTarget } from "@/lib/rag/semanticCache";

// THE GUEST'S OWN JUDGED SHADOW ROWS, keyed the way the matrix is.
//
// The same read keyModelSweep's `shadowPairs` performs, minus the texts: a
// verdict is a property of the (new_query, matched_query) pair, so it joins to a
// banked cosine by pair identity and needs nothing else. This is what makes the
// shadow half of the pool THEIRS — the clone carries 159 judged rows, so the
// leaderboard header adds up to what they actually hold, and a hand verdict in §2
// moves every row of §4.
//
// The F3 collision rule needs no restating here. The matrix is already the pooled
// set, so a probe row that duplicated a generated pair was dropped at capture
// time and simply has no shadow entry to match.
async function judgedShadowLabels(): Promise<Map<string, PairLabelLike>> {
  const rows = await sql<{ new_query: string; matched_query: string; verdict: string }[]>`
    select new_query, matched_query, verdict
      from semantic_cache_shadow
     where verdict is not null
       and config_id in (select id from configs where user_id = ${activeUserId()})
  `.catch((err: unknown) => {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  });
  return new Map(
    rows.map((r) => [
      pairIdentity(r.new_query, r.matched_query),
      // Answer-level, like the generated labels — "one answer serves both" — which
      // is what makes the two poolable at all.
      r.verdict === "accept" ? ("same" as const) : ("different" as const),
    ]),
  );
}

// Matrix + progress + the guest's verdicts, resolved together. Every entry point
// below starts here, so they cannot disagree about which pairs are in play.
async function currentSelection(): Promise<{
  matrix: ReplayMatrix;
  progress: ReplayProgress;
  // Carried out rather than re-read, so that the two entry points which
  // re-select after a write (advance, screen) spend one shadow read per request
  // rather than two.
  labels: Map<string, PairLabelLike>;
  selection: ReplaySelection;
} | null> {
  const matrix = await readMatrix();
  if (!matrix) return null;
  // Non-null for a guest by construction (readProgress' missing row reads as
  // zero-and-unscreened), but the compiler does not know that and neither should
  // a reader: one null check per fact.
  const progress = (await readProgress()) ?? { generated: 0, screened: false };
  const labels = await judgedShadowLabels();
  return { matrix, progress, labels, selection: selectReplay(matrix, progress, labels) };
}

// --- §1, the pair bank ------------------------------------------------------

// The counts line, over the first `n`. Null for a real account.
export async function replayBankCounts(): Promise<BankCounts | null> {
  return (await currentSelection())?.selection.bank ?? null;
}

// What advancing did, in the terms the panel reports it: how many pairs the
// visitor uncovered, how many they asked for, and how much of the matrix is
// still ahead.
export type ReplayAdvance = { revealed: number; requested: number; remaining: number; bank: BankCounts };

// GENERATE, for a guest. The pairs were written and audited on the operator's
// account and their cosines are banked, so the slider means "how far into the
// measurement to walk" — and `n` is CONTINUOUS: ask for 37 and the leaderboard
// re-derives over exactly the first 37, byte-identical to what a real sweep at
// that size would have printed. There is no checkpoint to round to.
//
// CLAMPED, NOT REFUSED, at the end of the matrix: a visitor who drags to the
// maximum twice has uncovered everything, which is a full answer and not an
// error. `revealed` is counted from the clamp rather than from the ask, so the
// number the panel prints is the number that moved.
//
// SCREENING IS NOT RESET by an advance, deliberately. It is a property of the
// visitor's session ("I have run the judge"), and the pairs that arrive after it
// arrive already screened — the operator screened them long ago. Re-arming it
// would be asking them to buy the same audit twice.
export async function advanceReplay(requested: number): Promise<ReplayAdvance | null> {
  const current = await currentSelection();
  if (!current) return null;
  const { matrix, progress, labels } = current;
  const total = matrix.pairs.filter((p) => p.source === "generated").length;
  const next = Math.min(progress.generated + Math.max(0, requested), total);
  const revealed = next - progress.generated;
  if (revealed > 0) {
    await writeProgress(activeUserId(), { ...progress, generated: next });
  }
  const after = selectReplay(matrix, { ...progress, generated: next }, labels);
  return { revealed, requested, remaining: after.bank.remaining, bank: after.bank };
}

// What the screen resolved, in the pair bank's own terms.
export type ReplayScreen = { resolved: number; quarantined: number; remaining: number };

// SCREEN, for a guest — the judge that doesn't call a judge. F3 already audited
// every one of these labels on the operator's account, and the matrix carries
// which pairs it contradicted, so this RESOLVES the quarantine over the pairs the
// visitor has reached instead of buying ~n judge calls to re-derive it.
//
// It is the real order of operations, not a shortcut: generate leaves pairs
// unscreened, screening is what admits them to the sweep, and the leaderboard
// moves when it runs because the quarantined pairs leave the pool.
//
// IDEMPOTENT. Screening twice resolves nothing the second time and says so — the
// flag is already set, and the count reported is what THIS press did.
export async function screenReplay(): Promise<ReplayScreen | null> {
  const current = await currentSelection();
  if (!current) return null;
  const { matrix, progress, labels, selection } = current;
  const resolved = progress.screened ? 0 : selection.bank.unscreened;
  if (!progress.screened) await writeProgress(activeUserId(), { ...progress, screened: true });
  const after = selectReplay(matrix, { ...progress, screened: true }, labels);
  return { resolved, quarantined: after.bank.quarantined, remaining: after.bank.remaining };
}

// --- §4, the leaderboard, and §3's pair-bank floor --------------------------

// THE LEADERBOARD at whatever `n` the visitor has reached, assembled from the
// matrix's first `n` generated rows pooled with their OWN judged shadow rows.
//
// `targetSource` is the guest's, because it names whose dial the target came from
// and the panel prints that config's label; the target ITSELF is the matrix's.
// See replaySweep in the core for why those two come from different places.
export async function replaySweepResult(): Promise<SweepResult | null> {
  const current = await currentSelection();
  if (!current) return null;
  const targetSource: EffectiveAcceptTarget = await scopedAcceptTarget();
  return replaySweep(current.matrix, current.selection, targetSource);
}

// THE PAIR-BANK COLLISION FLOOR — the max cosine among the hard negatives the
// visitor has reached, under `model`'s own column. Today this pill reads 0 for
// every guest, because the real path needs `embedding_cache` and the clone
// deliberately leaves those 107 MB behind.
//
// NO `top`, and it is not an omission: the matrix ships no pair TEXT, which is
// what lets the demo carry it at all. The panel renders nothing for an empty
// list, which is the honest outcome — the number is real, the two questions
// behind it are not something a guest is given.
export async function replayPairsFloor(
  model: string,
): Promise<{ floor: number | null; comparisons: number; missingVectors: number } | null> {
  const current = await currentSelection();
  if (!current) return null;
  return replayPairFloor(current.matrix, current.selection, model);
}

// --- §2, the queue's bulk judge ---------------------------------------------

// THE JUDGE THAT DOESN'T CALL A JUDGE — phase 4 of the plan.
//
// Clone step 5b blanks the queued rows' five judge columns so a visitor has
// something real to decide, and it used to THROW the operator's answers away.
// It banks them now, keyed by the guest's own shadow id, and this applies them:
// instant, free, and every verdict is the one the operator's judge actually
// returned over that exact pair.
//
// WHY NOT NULL FOR AN EMPTY BANK, which is where this parts company with
// replaySweepResult. A missing matrix means "this build published no sweep" and
// falling through to the ordinary refusal is the honest answer. A missing
// VERDICT is not that: the rows are here, the button is live, and returning null
// would hand the request back to a path that spends the operator's judge key on
// a guest's workspace. So a guest with nothing banked gets a truthful zero —
// judged 0, every row skipped — and the fallthrough stays reserved for the one
// case readShadowVerdicts itself calls null: not a guest, or no store at all.
//
// A HUMAN VERDICT IS NEVER OVERWRITTEN, which is `runJudgePass`'s own rule and
// holds here for a stronger reason: the visitor's own call is the only thing on
// this page that is not a replay.
export async function replayJudgeQueue(opts: {
  space: string;
  model: string;
  simMin?: number;
  simMax?: number;
  limit?: number;
  rejudge?: boolean;
}): Promise<JudgeRunResult | null> {
  const banked = await readShadowVerdicts();
  if (!banked) return null;

  // The same rows `runJudgePass` would have read, under the same predicate and
  // the same order, so the two passes disagree about nothing except who paid.
  const target = opts.rejudge
    ? sql`judge_source is distinct from 'human'`
    : sql`verdict is null`;
  const rows = await sql<{ id: string }[]>`
    select id
      from semantic_cache_shadow
     where space = ${opts.space}
       and ${ownedConfigs()}
       and sim >= ${opts.simMin ?? 0} and sim <= ${opts.simMax ?? 1}
       and ${target}
     order by sim desc
     limit ${Math.min(opts.limit ?? JUDGE_DEFAULT_LIMIT, JUDGE_MAX_LIMIT)}
  `;

  let accepted = 0;
  let rejected = 0;
  let skipped = 0;
  let model: string | null = null;
  for (const row of rows) {
    const verdict = banked.get(row.id);
    // Nothing banked for this row — a curve row swept in by a wide sim band, or a
    // queue row the clone's dedupe dropped. It is skipped, exactly as a row the
    // real judge declined to label is skipped, and for the same reason: this pass
    // has no verdict for it and will not invent one.
    if (!verdict || (verdict.verdict !== "accept" && verdict.verdict !== "reject")) {
      skipped++;
      continue;
    }
    // `judged_at` IS NOW, not the banked timestamp, and it is the one field here
    // that is deliberately not the operator's. The other four say what the
    // verdict is and who reached it; this one says when THIS row was decided, and
    // a guest's row stamped before their workspace existed would be a lie about
    // their own queue rather than a faithful copy of a measurement.
    await sql`
      update semantic_cache_shadow
         set verdict = ${verdict.verdict},
             judge_source = ${verdict.judge_source ?? "llm"},
             judge_model = ${verdict.judge_model ?? null},
             judge_reason = ${verdict.judge_reason ?? null},
             judged_at = now()
       where id = ${row.id}
         and ${ownedConfigs()}
         and judge_source is distinct from 'human'`;
    model ??= verdict.judge_model ?? null;
    if (verdict.verdict === "accept") accepted++;
    else rejected++;
  }

  // The MODEL REPORTED is the one that really produced these verdicts, read off
  // the bank rather than echoed back from the request: the panel prints it under
  // "judged by", and printing the model the visitor happened to have selected
  // would be the single sentence on this page claiming a call that never went out.
  return { judged: accepted + rejected, accepted, rejected, skipped, model: model ?? opts.model };
}
