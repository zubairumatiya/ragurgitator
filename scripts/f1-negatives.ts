// FOLLOW-UP F1 — feed HARD NEGATIVES into the shadow-judge calibration.
//
//   npm run f1 -- generate [origins]   write variants against BANKED cache entries
//   npm run f1 -- store-pairs          bank the variants in semantic_cache_pairs too
//   npm run f1 -- probe                run them through the lookup (serving OFF)
//   npm run f1 -- check                judge-vs-construction agreement + spot-check sample
//   npm run f1 -- judge [limit]        LLM-judge the shadow rows the probe created
//   npm run f1 -- adjudicate           dump the judge/construction disagreements to fill in
//   npm run f1 -- apply-truth          set the FINAL labels as human verdicts
//   npm run f1 -- sweep                precision-at-threshold curve
//   npm run f1 -- status               what exists so far
//
// WHY. Phase 8 could not recommend a τ from evidence: every judged shadow event was
// a legitimate match (91 accept, 0 reject), so the curve had one class and its
// "recommended τ = 0.81" was the lowest observed cosine rather than a boundary. A
// precision curve needs examples on BOTH sides, and real traffic on a six-document
// history corpus never produces a false hit above the 0.80 floor.
//
// SHAPE, and the two constraints that fix it:
//
//   1. Negatives are written against QUESTIONS ALREADY BANKED IN semantic_cache,
//      not against arbitrary eval questions. A negative whose origin isn't in the
//      cache has nothing to nearly-match, so it lands on some unrelated entry and
//      its constructed label describes a pair that never occurred.
//   2. Probes go through semanticCacheLookup with serve:false — the real lookup,
//      the real shadow machinery — and are NEVER stored. A pass that banked its own
//      probes would let the next one self-match at cosine 1.0 (the Phase 8 trap).
//
// GROUND TRUTH IS BY CONSTRUCTION, which inverts the usual roles: the LLM judge
// stops being the source of truth and becomes the thing being measured. `check`
// prints the confusion matrix of judge-verdict against constructed label. That is
// the point of F1 as much as the curve is.
//
// A constructed label is only VALID for a shadow row whose matched_query is the
// origin the variant was written against. The lookup picks the nearest banked
// entry, which for a hard negative is quite often a different question that
// legitimately deserves a different label — those rows are counted and excluded
// from truth, never silently relabelled.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import postgres from "postgres";

import { withUser } from "../lib/auth/userScope";
import { config as appConfig } from "../lib/config";
import { resolveConfig, withConfig } from "../lib/rag/activeConfig";
import { semanticCacheLookup, resolveKeyModel, scopedAcceptTarget } from "../lib/rag/semanticCache";
import {
  calibrationCurve,
  judgeShadowEvents,
  setHumanVerdict,
} from "../lib/rag/semanticCacheCalibration";
import { spaceOf } from "../lib/rag/semanticCacheCore";
import {
  insertPairs,
  pairRequestParams,
  pairsFrom,
  parsePairs,
} from "../lib/rag/semanticCachePairs";
import { meteredMessage } from "../lib/rag/meter";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });
const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

const PROBES = "docs/resume-metrics-f1-probes.json";
const SWEEP = "docs/resume-metrics-f1-sweep.json";
const ADJUDICATIONS = "docs/resume-metrics-f1-adjudications.json";

// Origins to write variants against. 40 × 6 variants ≈ 240 probes, which is an
// order of magnitude more judged events than Phase 8 had and still cents of haiku.
const DEFAULT_ORIGINS = 40;

type Probe = {
  text: string;
  // Ground truth BY CONSTRUCTION: 'different' = a hit here would be a false hit.
  label: "same" | "different";
  difficulty: "paraphrase" | "hard-negative";
  originText: string;
  originQuestionId: string | null;
  // Filled by `probe`.
  sim?: number | null;
  matchedQuery?: string | null;
  guardBlocked?: boolean | null;
  logged?: boolean; // cleared shadowLogFloor and has a shadow row
};

const USER = { id: "", email: "" };

const sha256 = async (text: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
};

function loadProbes(): Probe[] {
  if (!existsSync(PROBES)) throw new Error(`run "generate" first — ${PROBES} missing`);
  return JSON.parse(readFileSync(PROBES, "utf8"));
}

const saveProbes = (rows: Probe[]): void =>
  writeFileSync(PROBES, JSON.stringify(rows, null, 2) + "\n");

async function loadOwner(): Promise<void> {
  const [row] = await sql<{ user_id: string; email: string }[]>`
    select c.user_id, u.email from configs c join auth.users u on u.id = c.user_id
    where c.id = ${CONFIG_ID}`;
  if (!row) throw new Error(`config ${CONFIG_ID} not found`);
  USER.id = row.user_id;
  USER.email = row.email;
}

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return withUser(USER, async () => {
    const cfg = await resolveConfig(CONFIG_ID);
    if (!cfg) throw new Error("config not found in user scope");
    return withConfig(cfg, fn);
  });
}

// --- generate ---------------------------------------------------------------

// Banked entries a lookup from THIS config could actually match: same user, same
// key-model space, same answering model. Fingerprint is deliberately NOT filtered
// here — `probe` resolves the live one, and an entry under a stale fingerprint is
// unreachable, so it's excluded by the sim readback rather than by a second
// fingerprint computation that could disagree with the lookup's.
async function bankedOrigins(limit: number): Promise<{ text: string; questionId: string | null }[]> {
  const keyModel = await inScope(async () => resolveKeyModel(null));
  const rows = await sql<{ query_text: string; question_id: string | null }[]>`
    select c.query_text,
           (select q.id
              from eval_questions q
              join eval_labels l on l.eval_question_id = q.id
              join document_embeddings de on de.id = l.document_embedding_id
             where de.config_id = ${CONFIG_ID} and q.question = c.query_text
             limit 1) as question_id
    from semantic_cache c
    where c.user_id = ${USER.id}
      and c.embedding_model = ${keyModel}
    order by c.hit_count desc, c.created_at desc
    limit ${limit}`;
  return rows.map((r) => ({ text: r.query_text, questionId: r.question_id }));
}

// Variants come from the SAME prompt the key-model sweep uses (semanticCachePairs),
// so a negative here is the same object a pair-set negative is — one load-bearing
// detail changed, same topic and vocabulary. Paraphrases are generated alongside as
// POSITIVE CONTROLS: a curve built only from negatives has the opposite degeneracy
// to the one F1 exists to fix.
async function generate(nOrigins: number): Promise<void> {
  const counts = appConfig.semanticCache.keyModelSweep.pairsPerQuestion;
  const model = appConfig.semanticCache.keyModelSweep.generateModel;
  const origins = await bankedOrigins(nOrigins);
  if (origins.length === 0) throw new Error("no banked cache entries to write negatives against");
  console.log(`${origins.length} banked origins (${origins.filter((o) => o.questionId).length} map to eval questions)`);
  console.log(`generating ${counts.paraphrase} paraphrase + ${counts.hardNegative} hard-negative per origin with ${model}…`);

  const probes: Probe[] = [];
  let stored = 0;
  for (const [i, origin] of origins.entries()) {
    try {
      const resp = await inScope(() =>
        meteredMessage("cache_pairs", pairRequestParams(origin.text, null, counts, model)),
      );
      const pairs = pairsFrom(origin.text, parsePairs(resp));
      for (const p of pairs) {
        // pairsFrom canonicalises nothing — textA is always the origin, so textB is
        // the variant. Guard anyway: a variant equal to its origin is a tautology.
        const variant = p.textB === origin.text ? p.textA : p.textB;
        if (variant === origin.text) continue;
        probes.push({
          text: variant,
          label: p.label,
          difficulty: p.difficulty,
          originText: origin.text,
          originQuestionId: origin.questionId,
        });
      }
      // Bank them in semantic_cache_pairs too when the origin is an eval question,
      // so the key-model sweep gets the same set rather than paying to regenerate it.
      if (origin.questionId && pairs.length > 0) {
        stored += await inScope(() => insertPairs(origin.questionId!, pairs, model));
      }
    } catch (err) {
      console.warn(`\n  origin ${i} failed: ${(err as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${origins.length} → ${probes.length} variants   `);
  }
  process.stdout.write("\n");

  saveProbes(probes);
  const neg = probes.filter((p) => p.label === "different").length;
  console.log(`wrote ${PROBES}: ${probes.length} probes (${neg} hard-negative, ${probes.length - neg} paraphrase), ${stored} also stored as pairs`);
}

// Bank the probe file's variants in semantic_cache_pairs, for a run whose
// generation pass produced them but could not store them — the first F1 run hit
// exactly that, because insertPairs still named 0040's dropped conflict target.
// Reads the file rather than re-generating, so recovering costs nothing.
async function storePairs(): Promise<void> {
  const probes = loadProbes().filter((p) => p.originQuestionId);
  const model = appConfig.semanticCache.keyModelSweep.generateModel;
  const byOrigin = new Map<string, Probe[]>();
  for (const p of probes) {
    const key = p.originQuestionId!;
    if (!byOrigin.has(key)) byOrigin.set(key, []);
    byOrigin.get(key)!.push(p);
  }
  let inserted = 0;
  for (const [questionId, rows] of byOrigin) {
    inserted += await inScope(() =>
      insertPairs(
        questionId,
        rows.map((r) => ({
          textA: r.originText,
          textB: r.text,
          label: r.label,
          difficulty: r.difficulty,
        })),
        model,
      ),
    );
  }
  console.log(`inserted ${inserted} pairs across ${byOrigin.size} origin questions`);
}

// --- probe ------------------------------------------------------------------

// Run every variant through the REAL lookup with serving off. Nothing is banked:
// semanticCacheStore is never called, so the probe set can't become its own future
// match. The shadow row is written by the lookup itself (fire-and-forget, inline in
// a script since no detached queue is installed), so what lands in the table is
// exactly what real traffic would have landed.
async function probe(): Promise<void> {
  const probes = loadProbes();
  console.log(`probing ${probes.length} variants (serve off, floor ${appConfig.semanticCache.shadowLogFloor})…`);

  for (const [i, p] of probes.entries()) {
    try {
      await inScope(() => semanticCacheLookup(p.text, { serve: false, threshold: null, keyModel: null }));
    } catch (err) {
      console.warn(`\n  probe ${i} failed: ${(err as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${probes.length}   `);
  }
  process.stdout.write("\n");

  // Read back what the shadow log actually recorded. The lookup returns a miss with
  // no sim attached when serving is off, and the row is what calibration reads, so
  // the row is the authority — not anything reconstructed here.
  let logged = 0;
  for (const p of probes) {
    const hash = await sha256(p.text);
    const [row] = await sql<{ sim: string; matched_query: string; guard_blocked: boolean }[]>`
      select sim, matched_query, guard_blocked from semantic_cache_shadow
      where config_id = ${CONFIG_ID} and new_query_hash = ${hash}
      order by created_at desc limit 1`;
    p.logged = Boolean(row);
    p.sim = row ? Number(row.sim) : null;
    p.matchedQuery = row?.matched_query ?? null;
    p.guardBlocked = row?.guard_blocked ?? null;
    if (row) logged++;
  }
  saveProbes(probes);

  const below = probes.length - logged;
  const neg = probes.filter((p) => p.label === "different");
  console.log(`${logged}/${probes.length} recorded a shadow row; ${below} fell below the ${appConfig.semanticCache.shadowLogFloor} floor and are INVISIBLE to calibration (that is F2's evidence)`);
  console.log(`hard negatives recorded: ${neg.filter((p) => p.logged).length}/${neg.length}`);
  console.log(`matched their own origin: ${probes.filter((p) => p.logged && p.matchedQuery === p.originText).length}/${logged} (only these carry a usable constructed label)`);
}

// --- check: the judge is now the thing being measured -----------------------

type Joined = Probe & { verdict: "accept" | "reject" | null; judgeReason: string | null };

// Join the constructed labels onto whatever verdicts the shadow rows currently
// carry. Truth-valid rows only: matched_query must be the origin the variant was
// written against, or the constructed label is about a pair that didn't happen.
async function joinVerdicts(): Promise<{ all: Joined[]; truth: Joined[] }> {
  const probes = loadProbes();
  const all: Joined[] = [];
  for (const p of probes) {
    if (!p.logged) continue;
    const hash = await sha256(p.text);
    const [row] = await sql<{ verdict: "accept" | "reject" | null; judge_reason: string | null }[]>`
      select verdict, judge_reason from semantic_cache_shadow
      where config_id = ${CONFIG_ID} and new_query_hash = ${hash}
      order by created_at desc limit 1`;
    all.push({ ...p, verdict: row?.verdict ?? null, judgeReason: row?.judge_reason ?? null });
  }
  return { all, truth: all.filter((r) => r.matchedQuery === r.originText) };
}

const expected = (label: "same" | "different") => (label === "same" ? "accept" : "reject");

async function check(sample: number): Promise<void> {
  const { all, truth } = await joinVerdicts();
  const judged = truth.filter((r) => r.verdict !== null);
  console.log(`${all.length} shadow rows | ${truth.length} truth-valid | ${judged.length} judged`);
  if (judged.length === 0) {
    console.log('nothing judged yet — run "judge"');
    return;
  }

  // Confusion matrix of JUDGE against CONSTRUCTION. Read it as a measurement of the
  // judge: a negative the judge accepts is the judge saying a false hit was fine,
  // which is exactly the error that would let a swept τ run too low.
  const cell = (label: "same" | "different", verdict: "accept" | "reject") =>
    judged.filter((r) => r.label === label && r.verdict === verdict).length;
  const agree = judged.filter((r) => r.verdict === expected(r.label)).length;
  console.log("\n              judge:accept  judge:reject");
  console.log(`constructed same   ${String(cell("same", "accept")).padStart(8)}${String(cell("same", "reject")).padStart(14)}`);
  console.log(`constructed diff   ${String(cell("different", "accept")).padStart(8)}${String(cell("different", "reject")).padStart(14)}`);
  console.log(`\nagreement ${((agree / judged.length) * 100).toFixed(1)}% (${agree}/${judged.length})`);

  // The entity guard is measurable here for the first time: constructed labels say
  // what it SHOULD have blocked, so its recall on numeral/entity swaps is readable
  // rather than argued.
  const guarded = truth.filter((r) => r.guardBlocked);
  const negs = truth.filter((r) => r.label === "different");
  console.log(`entity guard blocked ${guarded.length} rows — ${guarded.filter((r) => r.label === "different").length} of ${negs.length} hard negatives, ${guarded.filter((r) => r.label === "same").length} paraphrases (those are its recall cost)`);

  // Hand spot-check, per the plan's warning: a generator that writes obviously
  // different negatives produces a curve that separates perfectly and recommends a
  // recklessly low τ. Disagreements first — they are where a bad negative shows up.
  const disagree = judged.filter((r) => r.verdict !== expected(r.label));
  const show = [...disagree, ...judged.filter((r) => !disagree.includes(r))].slice(0, sample);
  console.log(`\n--- spot-check (${show.length}; disagreements first) ---`);
  for (const r of show) {
    const flag = r.verdict === expected(r.label) ? "  " : "!!";
    console.log(`${flag} sim ${r.sim!.toFixed(4)} ${r.difficulty.padEnd(14)} truth=${expected(r.label).padEnd(6)} judge=${String(r.verdict).padEnd(6)}`);
    console.log(`     origin:  ${r.originText}`);
    console.log(`     variant: ${r.text}`);
    if (r.judgeReason) console.log(`     judge:   ${r.judgeReason.slice(0, 160)}`);
  }
}

// --- judge / truth / sweep --------------------------------------------------

async function judge(limit: number): Promise<void> {
  const space = await inScope(async () => spaceOf(resolveKeyModel(null)));
  const result = await inScope(() =>
    judgeShadowEvents({ space, model: appConfig.semanticCache.judgeBulkModel, limit }),
  );
  console.log(result);
}

// Adjudications — the hand calls on rows where CONSTRUCTION and the JUDGE disagree.
// Keyed by variant text so the file survives a re-probe (ids don't).
type Adjudication = { text: string; label: "same" | "different"; why: string };

function loadAdjudications(): Map<string, Adjudication> {
  if (!existsSync(ADJUDICATIONS)) return new Map();
  const rows: Adjudication[] = JSON.parse(readFileSync(ADJUDICATIONS, "utf8"));
  return new Map(rows.filter((r) => r.label).map((r) => [r.text, r]));
}

// Dump every construction-vs-judge disagreement as a fill-in-the-blank file. Both
// sides are shown because BOTH are fallible here and the first run proved it: the
// generator wrote "Ruhr" vs "Ruhr Valley" as a hard negative, and separately wrote
// "how many OTHER nations" vs "the TOTAL number of nations" as a paraphrase.
async function adjudicateTemplate(): Promise<void> {
  const { truth } = await joinVerdicts();
  const existing = loadAdjudications();
  const rows = truth
    .filter((r) => r.verdict !== null && r.verdict !== expected(r.label))
    .map((r) => ({
      text: r.text,
      label: existing.get(r.text)?.label ?? null,
      why: existing.get(r.text)?.why ?? "",
      _origin: r.originText,
      _constructed: expected(r.label),
      _judge: r.verdict,
      _sim: r.sim,
      _judgeReason: r.judgeReason,
    }));
  writeFileSync(ADJUDICATIONS, JSON.stringify(rows, null, 2) + "\n");
  console.log(`wrote ${ADJUDICATIONS}: ${rows.length} disagreements, ${rows.filter((r) => r.label).length} already adjudicated`);
}

// Write the FINAL labels onto the truth-valid rows as human verdicts, which is what
// makes the curve a real precision curve rather than a poll of the judge. Human is
// the right source: a later judge pass never overrides judge_source='human'.
//
// The final label is the constructed one WHERE THE JUDGE AGREES, and the hand
// adjudication where it doesn't. Refuses to run while any disagreement is
// unadjudicated — the plan's "spot-check the generated pairs by hand before
// applying any threshold derived from them" is a precondition, so it's enforced
// here rather than left as a comment someone can skip. Construction alone would
// have written 8 wrong labels on this run's 162; the judge alone, 4.
async function applyTruth(): Promise<void> {
  const { truth } = await joinVerdicts();
  const adjudications = loadAdjudications();
  const unresolved = truth.filter(
    (r) => r.verdict !== null && r.verdict !== expected(r.label) && !adjudications.has(r.text),
  );
  if (unresolved.length > 0) {
    console.error(`${unresolved.length} disagreement(s) not adjudicated — run "adjudicate" and fill in ${ADJUDICATIONS} first`);
    process.exitCode = 1;
    return;
  }

  let written = 0;
  let fromAdjudication = 0;
  for (const r of truth) {
    const adjudicated = adjudications.get(r.text);
    if (adjudicated) fromAdjudication++;
    const label = adjudicated?.label ?? r.label;
    const hash = await sha256(r.text);
    const [row] = await sql<{ id: string }[]>`
      select id from semantic_cache_shadow
      where config_id = ${CONFIG_ID} and new_query_hash = ${hash}
      order by created_at desc limit 1`;
    if (!row) continue;
    await inScope(() => setHumanVerdict(row.id, expected(label)));
    written++;
    process.stdout.write(`\r  ${written}/${truth.length}   `);
  }
  process.stdout.write("\n");
  console.log(`wrote ${written} final labels as human verdicts (${fromAdjudication} from hand adjudication, ${written - fromAdjudication} constructed)`);
}

async function sweep(): Promise<void> {
  const report = await inScope(async () =>
    calibrationCurve(spaceOf(resolveKeyModel(null)), await scopedAcceptTarget()),
  );
  console.log(`space ${report.space} | target ${report.targetSource.target} | recommended τ ${report.recommended ?? "(none)"}`);
  console.log(`judged ${report.totalJudged} (${report.totalAccepts} accept, ${report.totalJudged - report.totalAccepts} reject) | ` +
    `coverage@τ ${report.coverageAtRecommended ?? "—"} | precision@τ ${report.precisionAtRecommended ?? "—"}`);
  console.log("\n" + "sim".padEnd(9) + "n".padStart(5) + "precision".padStart(12) + "coverage".padStart(11));
  for (const p of report.curve) {
    console.log(
      p.sim.toFixed(4).padEnd(9),
      String(p.n).padStart(4),
      ((p.acceptRateAtOrAbove * 100).toFixed(1) + "%").padStart(11),
      ((p.coverageAtOrAbove * 100).toFixed(1) + "%").padStart(10),
    );
  }
  writeFileSync(SWEEP, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${SWEEP}`);
}

async function status(): Promise<void> {
  if (!existsSync(PROBES)) {
    console.log(`no ${PROBES} yet — start with "generate"`);
  } else {
    const probes = loadProbes();
    const neg = probes.filter((p) => p.label === "different");
    console.log(`probes ${probes.length} (${neg.length} negative) | logged ${probes.filter((p) => p.logged).length} | ` +
      `truth-valid ${probes.filter((p) => p.logged && p.matchedQuery === p.originText).length}`);
  }
  const [row] = await sql<{ total: string; judged: string; rejects: string; human: string }[]>`
    select count(*) as total, count(verdict) as judged,
           count(*) filter (where verdict = 'reject') as rejects,
           count(*) filter (where judge_source = 'human') as human
    from semantic_cache_shadow where config_id = ${CONFIG_ID}`;
  console.log(`shadow rows ${row.total} | judged ${row.judged} | reject ${row.rejects} | human-labeled ${row.human}`);
}

async function main(): Promise<void> {
  await loadOwner();
  const [verb, arg] = process.argv.slice(2);
  switch (verb) {
    case "generate": await generate(arg ? Number(arg) : DEFAULT_ORIGINS); break;
    case "store-pairs": await storePairs(); break;
    case "probe": await probe(); break;
    case "judge": await judge(arg ? Number(arg) : 500); break;
    case "check": await check(arg ? Number(arg) : 15); break;
    case "adjudicate": await adjudicateTemplate(); break;
    case "apply-truth": await applyTruth(); break;
    case "sweep": await sweep(); break;
    case "status": await status(); break;
    default:
      console.log(" verbs: generate [origins] | store-pairs | probe | judge [limit] | check [sample] | adjudicate | apply-truth | sweep | status");
  }
}

main().then(async () => {
  await sql.end();
  process.exit(0);
}, async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
