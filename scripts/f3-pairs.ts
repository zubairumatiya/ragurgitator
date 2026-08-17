// FOLLOW-UP F3 — is the generated pair set actually labelled correctly?
//
//   npm run f3 -- judge [limit]  LLM-judge every pair against its origin's answer
//   npm run f3 -- check          judge-vs-construction, split by difficulty
//   npm run f3 -- adjudicate     dump the disagreements to fill in by hand
//   npm run f3 -- apply-truth    write the FINAL labels as human verdicts
//   npm run f3 -- status         judged / disputed / adjudicated / quarantined
//
// WHY. semantic_cache_pairs holds 216 pairs — 36 eval questions × (3 paraphrases +
// 3 hard negatives) — every one written by claude-haiku-4-5 and never checked by a
// human. pooledPairs() feeds them straight into the key-model embedding sweep, so
// every key-model ranking inherits whatever error rate is in there. Both earlier
// follow-ups measured that rate on the rows a judge disputed and found it bad: F1's
// generator was wrong 8 times of 12, F2's 2 of 3, and F2's mistakes were not subtle
// (two "hard negatives" were answered verbatim by the matched entry).
//
// The point is NOT to measure and move on. A measured error rate leaves the sweep
// consuming the same bad rows, so the outcome here is the QUARANTINE: listPairs()
// now drops any row whose final verdict contradicts its constructed label.
//
// NO NEW RUBRIC. The pairs are judged with judgeOne + JUDGE_SYSTEM, the same prompt
// the shadow log uses, because a generated pair IS a (new question, stored question,
// stored answer) triple once the origin question supplies the last two. Using a
// second rubric here would measure the gap between two prompts rather than the
// generator's error rate — and the sweep already pools these labels with shadow
// verdicts, which is only sound if the two mean the same thing.
//
// JUDGED WITH THE BOUNDARY MODEL (claude-sonnet-4-6), not the usual bulk judge. The
// bulk judge is claude-haiku-4-5 — the model that WROTE these pairs — and a
// generator auditing its own output shares its blind spots. At 216 rows the upgrade
// is cents.
//
// Nothing here embeds anything: F3 judges text. The one embedding cost in this
// follow-up is re-running the key-model sweep afterwards, which is a UI action and
// a documented hour (see the plan doc).
import { existsSync } from "node:fs";

import postgres from "postgres";

import { config as appConfig } from "../lib/config";
import { judgeOne } from "../lib/rag/semanticCacheCalibration";
import {
  pairsForJudging,
  setPairVerdict,
  type PairForJudging,
} from "../lib/rag/semanticCachePairs";
import {
  CONFIG_ID,
  expected,
  inScope,
  loadAdjudications,
  loadOwner,
  printMatrix,
  unadjudicated,
  writeAdjudicationTemplate,
  type Owner,
} from "./lib/followup";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });

const ADJUDICATIONS = "docs/resume-metrics-f3-adjudications.json";

let owner: Owner;
const scoped = <T>(fn: () => Promise<T>): Promise<T> => inScope(owner, fn);

const load = (): Promise<PairForJudging[]> => scoped(pairsForJudging);

// A pair the judge has ruled on, and disagreed with. `id` is the key rather than the
// text: unlike f1/f2's probes, two pairs can share a variant text under different
// origins, and the row id is what apply-truth writes back to anyway.
const disputes = (pairs: PairForJudging[]): PairForJudging[] =>
  pairs.filter((p) => p.verdict !== null && p.verdict !== expected(p.label));

// --- judge -------------------------------------------------------------------

// RESUMABLE: rows that already carry a verdict are skipped, so an interrupted pass
// resumes where it stopped instead of re-paying. F1 lost a probe to a pooler
// CONNECTION_CLOSED at 238/240, which is why every pass in this family is written
// this way rather than as a single transaction.
//
// A pair with no stored answer cannot be judged with this rubric — the judge is
// asked whether serving THAT ANSWER was right — so it is left unjudged and counted,
// never judged on the questions alone. (All 216 rows here have one.)
async function judge(limit: number): Promise<void> {
  const model = appConfig.semanticCache.judgeBoundaryModel;
  const pairs = await load();
  const todo = pairs.filter((p) => p.verdict === null && p.expectedAnswer !== null);
  const noAnswer = pairs.filter((p) => p.verdict === null && p.expectedAnswer === null).length;
  const batch = todo.slice(0, limit);

  console.log(
    `${pairs.length} pairs | ${pairs.length - todo.length - noAnswer} already judged | ` +
      `judging ${batch.length} of ${todo.length} with ${model}`,
  );
  if (noAnswer > 0) console.log(`${noAnswer} skipped: origin question has no stored answer`);

  let judged = 0;
  let unparsed = 0;
  let failed = 0;
  for (const [i, p] of batch.entries()) {
    try {
      // The variant is the NEW question and the origin is the STORED one — the
      // direction the cache actually runs in. pairsForJudging resolves those roles
      // from eval_questions; text_a is NOT reliably the origin (canonical hash
      // ordering flips it for over half these rows).
      const { verdict, reason } = await scoped(() =>
        judgeOne(model, p.variantText, p.originText, p.expectedAnswer!),
      );
      if (verdict === null) {
        unparsed++;
      } else {
        await scoped(() => setPairVerdict(p.id, verdict, "llm", model, reason));
        judged++;
      }
    } catch (err) {
      // One bad row must not abandon the pass — it stays unjudged and the next run
      // picks it up.
      console.warn(`\n  pair ${p.id} failed: ${(err as Error).message}`);
      failed++;
    }
    process.stdout.write(`\r  ${i + 1}/${batch.length}   `);
  }
  process.stdout.write("\n");
  console.log(`judged ${judged}${unparsed ? `, ${unparsed} unparseable reply (left unjudged)` : ""}${failed ? `, ${failed} failed` : ""}`);
  if (todo.length > batch.length) console.log(`${todo.length - batch.length} still unjudged — run again`);
}

// --- check -------------------------------------------------------------------

// The headline number, and the per-difficulty split that says WHERE the generator
// fails. The two halves are not interchangeable: a mislabelled paraphrase costs the
// sweep a little recall, while a mislabelled hard negative is a false negative the
// sweep uses to punish models that got it RIGHT — and hard negatives are the only
// rows that discriminate between candidates at all.
async function check(): Promise<void> {
  const pairs = await load();
  const judged = pairs.filter((p) => p.verdict !== null);
  console.log(`${pairs.length} pairs | ${judged.length} judged`);
  if (judged.length === 0) {
    console.log('nothing judged yet — run "judge"');
    return;
  }

  printMatrix(pairs, "ALL");
  for (const difficulty of ["paraphrase", "hard-negative"] as const) {
    printMatrix(pairs.filter((p) => p.difficulty === difficulty), difficulty);
  }

  const bad = disputes(pairs);
  console.log(`\n--- ${bad.length} disagreement(s), judge vs construction ---`);
  for (const p of bad) {
    console.log(`\n!! ${p.difficulty}  constructed=${expected(p.label)}  judge=${p.verdict}${p.verdictSource === "human" ? "  [human]" : ""}`);
    console.log(`   origin:  ${p.originText}`);
    console.log(`   variant: ${p.variantText}`);
    if (p.judgeReason) console.log(`   judge:   ${p.judgeReason.slice(0, 200)}`);
  }

  // A spot-check of agreed rows too. A judge that agrees for the wrong reason is
  // invisible in the matrix, and F1 found the entity guard's blind spot only by
  // reading rows nobody disputed.
  const agreed = pairs.filter((p) => p.verdict !== null && p.verdict === expected(p.label));
  // First three and last three, de-duplicated so a short set doesn't print twice.
  const sample = [...new Set([...agreed.slice(0, 3), ...agreed.slice(-3)])];
  console.log(`\n--- spot check: ${sample.length} of ${agreed.length} agreed rows ---`);
  for (const p of sample) {
    console.log(`   [${p.difficulty}] ${p.variantText.slice(0, 90)}`);
    console.log(`      vs origin: ${p.originText.slice(0, 90)}`);
  }
}

// --- adjudicate / apply-truth ------------------------------------------------

// THE HAND STEP. The run stops here until docs/resume-metrics-f3-adjudications.json
// has a `label` on every row — see followup.ts for why neither side of a
// disagreement is trusted to settle it.
async function adjudicate(): Promise<void> {
  const bad = disputes(await load());
  const filled = writeAdjudicationTemplate(
    ADJUDICATIONS,
    bad,
    (p) => p.id,
    (p) => ({
      _origin: p.originText,
      _variant: p.variantText,
      _difficulty: p.difficulty,
      _constructed: expected(p.label),
      _judge: p.verdict,
      _judgeReason: p.judgeReason,
      _storedAnswer: p.expectedAnswer?.slice(0, 400) ?? null,
    }),
  );
  console.log(`wrote ${ADJUDICATIONS}: ${bad.length} disagreements, ${filled} already adjudicated`);
  if (bad.length > filled) {
    console.log(`fill in "label" ("same" | "different") and "why" for the remaining ${bad.length - filled}, then run apply-truth`);
  }
}

// Write the settled truth back as HUMAN verdicts, which is what makes the
// quarantine trustworthy: a later `judge` pass never overrides verdict_source
// 'human', so a hand decision survives a re-judge of the whole table.
//
// Only the disputed rows are written. An agreed row's LLM verdict already equals
// its constructed label, so stamping it 'human' would claim a hand check that never
// happened — and it changes nothing, since the quarantine only ever looks at whether
// verdict contradicts label.
async function applyTruth(): Promise<void> {
  const pairs = await load();
  const bad = disputes(pairs);
  const adjudications = loadAdjudications(ADJUDICATIONS);
  const unresolved = unadjudicated(bad.map((p) => p.id), adjudications);
  if (unresolved.length > 0) {
    console.error(
      `${unresolved.length} of ${bad.length} disagreement(s) not adjudicated — ` +
        `run "adjudicate" and fill in ${ADJUDICATIONS} first`,
    );
    process.exitCode = 1;
    return;
  }

  let generatorWrong = 0;
  let judgeWrong = 0;
  for (const p of bad) {
    const label = adjudications.get(p.id)!.label!;
    // The hand label is the truth. Where it matches the construction the JUDGE was
    // wrong, and the row keeps its constructed label (so it stays in the sweep);
    // where it matches the judge the GENERATOR was wrong, and the row is quarantined.
    if (label === p.label) judgeWrong++;
    else generatorWrong++;
    await scoped(() => setPairVerdict(p.id, expected(label), "human", null, adjudications.get(p.id)!.why || null));
  }
  console.log(`wrote ${bad.length} human verdicts: generator wrong ${generatorWrong}, judge wrong ${judgeWrong}`);
  console.log(`${generatorWrong} row(s) are now quarantined out of the sweep`);
}

// --- status ------------------------------------------------------------------

async function status(): Promise<void> {
  const pairs = await load();
  const judged = pairs.filter((p) => p.verdict !== null);
  const bad = disputes(pairs);
  const human = pairs.filter((p) => p.verdictSource === "human").length;
  const adjudications = existsSync(ADJUDICATIONS) ? loadAdjudications(ADJUDICATIONS) : new Map();
  const quarantined = bad.filter((p) => p.verdictSource === "human").length;

  console.log(`config ${CONFIG_ID} (${owner.email})`);
  console.log(`pairs ${pairs.length} | judged ${judged.length} | disputed ${bad.length} | human verdicts ${human}`);
  console.log(`adjudications on file ${adjudications.size}${bad.length > adjudications.size ? ` (${bad.length - adjudications.size} outstanding)` : ""}`);
  console.log(`QUARANTINED (excluded from the sweep) ${quarantined} of ${pairs.length}`);
  for (const difficulty of ["paraphrase", "hard-negative"] as const) {
    const set = pairs.filter((p) => p.difficulty === difficulty);
    console.log(
      `  ${difficulty.padEnd(14)} ${String(set.length).padStart(3)} pairs, ` +
        `${set.filter((p) => p.verdict !== null).length} judged, ${disputes(set).length} disputed`,
    );
  }
}

async function main(): Promise<void> {
  owner = await loadOwner(sql);
  const [verb, arg] = process.argv.slice(2);
  switch (verb) {
    case "judge": await judge(arg ? Number(arg) : 250); break;
    case "check": await check(); break;
    case "adjudicate": await adjudicate(); break;
    case "apply-truth": await applyTruth(); break;
    case "status": await status(); break;
    default:
      console.log(" verbs: judge [limit] | check | adjudicate | apply-truth | status");
  }
}

// Exit with whatever a verb SET, not a hardcoded 0. apply-truth's refusal is a
// real failure a caller (or CI) must be able to see; f1/f2 hardcode process.exit(0)
// here, so their refusal path returns success and the gate only exists on screen.
main().then(async () => {
  await sql.end();
  process.exit(process.exitCode ?? 0);
}, async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
