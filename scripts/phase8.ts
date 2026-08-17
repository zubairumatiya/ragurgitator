// Drive Phase 8 — the savings levers on the chat path — as a sequence of measured
// steps against the live config.
//
//   npm run phase8 -- questions          draw and FREEZE the question sets
//   npm run phase8 -- run baseline       cascade off, serve off  (step 1)
//   npm run phase8 -- run cascade        cascade on,  serve off  (step 2)
//   npm run phase8 -- run mix            the mixed set, serve off — fills the shadow log
//   npm run phase8 -- judge              LLM-judge the shadow events
//   npm run phase8 -- sweep              precision-at-threshold curve
//   npm run phase8 -- run serve <tau>    serve on at tau, replay the mix (step 3)
//   npm run phase8 -- status             what has run so far
//
// WHY IN-PROCESS, NOT OVER HTTP. /api/chat is session-gated (withRequestConfig →
// Supabase cookies), and minting a browser session from a script to measure 160
// generations would add an auth dance to every number without changing any of them.
// Calling ask() inside withUser + withConfig enters the SAME two scopes the route
// enters, so retrieval, the cascade, the cache and the ledger all behave identically.
// The one deliberate difference: no detached queue is installed, so the ledger
// writes ask() defers run INLINE (lib/detached.ts falls back to that by design) —
// which is what we want here, since the step's totals must be settled before the
// after-snapshot is read.
//
// COST IS MEASURED, NOT ESTIMATED. Every step brackets itself with a snapshot of
// savings_totals + spend_totals and reports the diff, so a step's dollars come from
// the same ledger the /appraise/costs page reads rather than from a token count
// recomputed here. Steps are therefore order-dependent and each records its own
// before/after — re-running one is safe, appending a second row for it is not.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import postgres from "postgres";

import { withUser } from "../lib/auth/userScope";
import { config as appConfig } from "../lib/config";
import { resolveConfig, withConfig } from "../lib/rag/activeConfig";
import { updateBatchSavings } from "../lib/rag/batchStore";
import { ask } from "../lib/rag/pipeline";
import {
  calibrationCurve,
  judgeShadowEvents,
  setHumanVerdict,
} from "../lib/rag/semanticCacheCalibration";
import { resolveKeyModel, scopedAcceptTarget } from "../lib/rag/semanticCache";
import { spaceOf } from "../lib/rag/semanticCacheCore";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });
const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

const QUESTIONS = "docs/resume-metrics-8-questions.json";
const PROGRESS = "docs/resume-metrics-8-progress.json";

// Step 1 and 2 must ask the SAME questions or the cascade's saving is confounded
// with question difficulty. 40 is the plan's number.
const N_CHAT = 40;
// The mix, stated as a mix because the cache's dollar figure is meaningless without
// it (plan §8 integrity note). Repeats and paraphrases are drawn from the step-1/2
// set, which by then is already banked in the cache; distinct questions are drawn
// from questions no step has asked.
const MIX = { repeat: 15, paraphrase: 20, distinct: 25 };
const SEED = 20260816;

type QuestionSets = {
  seed: number;
  chat: { id: string; question: string }[];
  mix: { kind: "repeat" | "paraphrase" | "distinct"; question: string; ofId: string | null }[];
  // Each serving pass needs its OWN never-asked mix: a pass banks every question
  // it answers, so replaying the same mix at a second threshold would self-match
  // at cosine 1.0 and report a 100% hit rate whatever the threshold is.
  [mix: `mix${number}`]: unknown;
};

type MixItem = { kind: "repeat" | "paraphrase" | "distinct"; question: string; ofId: string | null };

type Ledger = { savings: Record<string, { events: number; usd: number }>; spend: Record<string, { tokens: number; usd: number }> };

type StepResult = {
  step: string;
  startedAt: string;
  minutes: number;
  cascadeEnabled: boolean;
  serve: boolean;
  threshold: number | null;
  asked: number;
  cacheHits: number;
  escalated: number;
  byModel: Record<string, number>;
  before: Ledger;
  after: Ledger;
  deltaSpendUsd: number;
  deltaSavingsUsd: Record<string, number>;
  perQuestion: { question: string; kind: string; model: string; cacheHit: boolean; escalated: boolean; ms: number }[];
};

const USER = { id: "", email: "" };

// --- helpers ---------------------------------------------------------------

// Deterministic so a re-draw reproduces the same sets — the two chat steps compare
// only if they asked the same questions, and a lost questions file must be
// reconstructible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function readLedger(): Promise<Ledger> {
  const savings = await sql<{ lever: string; event_count: string; saved_usd: string }[]>`
    select lever, event_count, saved_usd from savings_totals where config_id = ${CONFIG_ID}`;
  const spend = await sql<{ surface: string; tokens: string; spent_usd: string }[]>`
    select surface, tokens, spent_usd from spend_totals where config_id = ${CONFIG_ID}`;
  return {
    savings: Object.fromEntries(savings.map((r) => [r.lever, { events: Number(r.event_count), usd: Number(r.saved_usd) }])),
    spend: Object.fromEntries(spend.map((r) => [r.surface, { tokens: Number(r.tokens), usd: Number(r.spent_usd) }])),
  };
}

async function chatSpend(): Promise<number> {
  const [row] = await sql<{ spent_usd: string }[]>`
    select spent_usd from spend_totals where config_id = ${CONFIG_ID} and surface = 'chat'`;
  return row ? Number(row.spent_usd) : 0;
}

function ledgerDelta(before: Ledger, after: Ledger) {
  const spendUsd = Object.entries(after.spend).reduce(
    (sum, [k, v]) => sum + v.usd - (before.spend[k]?.usd ?? 0), 0);
  const savings: Record<string, number> = {};
  for (const [k, v] of Object.entries(after.savings)) {
    const d = v.usd - (before.savings[k]?.usd ?? 0);
    if (Math.abs(d) > 1e-12) savings[k] = d;
  }
  return { spendUsd, savings };
}

function loadProgress(): StepResult[] {
  return existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : [];
}

function saveProgress(rows: StepResult[]): void {
  writeFileSync(PROGRESS, JSON.stringify(rows, null, 2) + "\n");
}

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

// --- lever control ---------------------------------------------------------

async function setCascade(on: boolean): Promise<void> {
  await sql`update configs set cascade_enabled = ${on}, updated_at = now() where id = ${CONFIG_ID}`;
}

async function setServe(serve: boolean, threshold: number | null): Promise<void> {
  await withUser(USER, () => updateBatchSavings(CONFIG_ID, { semanticCache: { serve, threshold } }));
}

// --- question sets ---------------------------------------------------------

async function drawQuestions(): Promise<void> {
  const rows = await sql<{ id: string; question: string; document_id: string }[]>`
    select q.id, q.question, q.document_id
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${CONFIG_ID}
    order by q.id`;
  const rand = rng(SEED);

  // Stratify across documents so 40 questions aren't 40 questions about one file —
  // the cascade's escalation rate is a property of the corpus, not of one document.
  const byDoc = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, [] as unknown as typeof rows);
    byDoc.get(r.document_id)!.push(r);
  }
  const pools = [...byDoc.values()].map((v) => shuffled(v, rand));
  const picked: typeof rows = [] as unknown as typeof rows;
  const spare: typeof rows = [] as unknown as typeof rows;
  for (let i = 0; picked.length < N_CHAT + MIX.distinct; i++) {
    let any = false;
    for (const pool of pools) {
      if (i >= pool.length) continue;
      any = true;
      picked.push(pool[i]);
      if (picked.length >= N_CHAT + MIX.distinct) break;
    }
    if (!any) break;
  }
  const chat = picked.slice(0, N_CHAT);
  const distinct = picked.slice(N_CHAT, N_CHAT + MIX.distinct);
  void spare;

  const repeatSrc = shuffled(chat, rand).slice(0, MIX.repeat);
  const paraSrc = shuffled(chat, rand).slice(0, MIX.paraphrase);
  console.log(`drawing ${MIX.paraphrase} paraphrases with ${appConfig.semanticCache.keyModelSweep.generateModel}…`);
  const paraphrases = await inScope(() => paraphrase(paraSrc.map((r) => r.question)));

  const sets: QuestionSets = {
    seed: SEED,
    chat: chat.map((r) => ({ id: r.id, question: r.question })),
    mix: shuffled(
      [
        ...repeatSrc.map((r) => ({ kind: "repeat" as const, question: r.question, ofId: r.id })),
        ...paraSrc.map((r, i) => ({ kind: "paraphrase" as const, question: paraphrases[i], ofId: r.id })),
        ...distinct.map((r) => ({ kind: "distinct" as const, question: r.question, ofId: null })),
      ],
      rand,
    ),
  };
  writeFileSync(QUESTIONS, JSON.stringify(sets, null, 2) + "\n");
  console.log(`wrote ${QUESTIONS}: ${sets.chat.length} chat, ${sets.mix.length} mix ` +
    `(${MIX.repeat} repeat / ${MIX.paraphrase} paraphrase / ${MIX.distinct} distinct)`);
}

// A SECOND, UNASKED mix — the one the serving pass replays.
//
// Replaying the FIRST mix with serving on would measure nothing: that run banked
// all 60 of its own questions, so every one of them would self-match at cosine 1.0
// and the hit rate would read 100% by construction. That is precisely the "ask one
// question fifty times" artifact the plan's integrity note warns about, arrived at
// by accident rather than by fudging.
//
// So mix 2 is drawn fresh: repeats and paraphrases point at the step-1/2 chat set
// (banked, and legitimately re-askable), while its distinct questions are ones no
// step has asked at all. Paraphrases are re-generated rather than reused, or they
// would be exact repeats of mix 1's paraphrases.
async function drawSecondMix(index: number): Promise<void> {
  const sets: QuestionSets = JSON.parse(readFileSync(QUESTIONS, "utf8"));
  const asked = new Set<string>(loadProgress().flatMap((r) => r.perQuestion.map((q) => q.question)));
  const rows = await sql<{ id: string; question: string }[]>`
    select q.id, q.question
    from eval_questions q
    join eval_labels l on l.eval_question_id = q.id
    join document_embeddings de on de.id = l.document_embedding_id
    where de.config_id = ${CONFIG_ID}
    order by q.id`;
  const rand = rng(SEED + index);
  const unasked = shuffled(rows.filter((r) => !asked.has(r.question)), rand);
  if (unasked.length < MIX.distinct) throw new Error(`only ${unasked.length} unasked questions left`);

  const repeatSrc = shuffled(sets.chat, rand).slice(0, MIX.repeat);
  const paraSrc = shuffled(sets.chat, rand).slice(0, MIX.paraphrase);
  console.log(`drawing ${MIX.paraphrase} fresh paraphrases…`);
  const paraphrases = await inScope(() => paraphrase(paraSrc.map((r) => r.question)));

  const mix2 = shuffled(
    [
      ...repeatSrc.map((r) => ({ kind: "repeat" as const, question: r.question, ofId: r.id })),
      ...paraSrc.map((r, i) => ({ kind: "paraphrase" as const, question: paraphrases[i], ofId: r.id })),
      ...unasked.slice(0, MIX.distinct).map((r) => ({ kind: "distinct" as const, question: r.question, ofId: null })),
    ],
    rand,
  );
  writeFileSync(QUESTIONS, JSON.stringify({ ...sets, [`mix${index}`]: mix2 }, null, 2) + "\n");
  console.log(`wrote mix${index}: ${mix2.length} questions ` +
    `(${MIX.repeat} repeat / ${MIX.paraphrase} paraphrase / ${MIX.distinct} distinct, none previously asked)`);
}

// Paraphrases must preserve the ANSWER while changing the wording — that is the
// only kind of near-duplicate a cache is entitled to serve. Numbers and proper
// nouns are held fixed on purpose: the entity guard refuses a match whose numerals
// differ, so a paraphrase that drifted on a date would test the guard rather than
// the threshold.
async function paraphrase(questions: string[]): Promise<string[]> {
  const { meteredMessage } = await import("../lib/rag/meter");
  const out: string[] = [];
  for (const q of questions) {
    const resp = await meteredMessage("cache_pairs", {
      model: appConfig.semanticCache.keyModelSweep.generateModel,
      max_tokens: 200,
      messages: [{
        role: "user",
        content:
          "Reword this question so it asks for exactly the same answer in different words. " +
          "Keep every number, date, name and acronym EXACTLY as written. " +
          "Reply with the reworded question only, no preamble.\n\n" + q,
      }],
    });
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("").trim();
    out.push(text || q);
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return out;
}

// --- the measured steps ----------------------------------------------------

async function runStep(step: string, tau: number | null, mixIndex = 2): Promise<void> {
  if (!existsSync(QUESTIONS)) throw new Error(`run "questions" first — ${QUESTIONS} missing`);
  const sets: QuestionSets = JSON.parse(readFileSync(QUESTIONS, "utf8"));

  const plan: { question: string; kind: string }[] =
    step === "baseline" || step === "cascade"
      ? sets.chat.map((q) => ({ question: q.question, kind: "chat" }))
      : step === "serve"
        ? ((sets[`mix${mixIndex}`] as MixItem[] | undefined) ?? []).map((m) => ({ question: m.question, kind: m.kind }))
        : sets.mix.map((m) => ({ question: m.question, kind: m.kind }));
  if (plan.length === 0) throw new Error(`no questions for step "${step}" — run "questions2" first?`);

  const cascadeOn = step !== "baseline";
  const serve = step === "serve";
  await setCascade(cascadeOn);
  await setServe(serve, tau);
  console.log(`step=${step} cascade=${cascadeOn} serve=${serve} threshold=${tau ?? "(inherited)"} n=${plan.length}`);

  const before = await readLedger();
  const startedAt = new Date();
  const perQuestion: StepResult["perQuestion"] = [];
  const byModel: Record<string, number> = {};
  let cacheHits = 0;
  let escalated = 0;

  for (const [i, item] of plan.entries()) {
    // A served cache hit replays a banked answer, skipping retrieval AND
    // generation. ask() returns no flag for it — the observable difference is that
    // the chat surface didn't move — so the hit is read off the ledger. Cheap, and
    // it measures the thing that matters (a generation not paid for) rather than
    // trusting a flag to mean that.
    const spentBefore = await chatSpend();
    const t0 = Date.now();
    const res = await inScope(() => ask(item.question));
    const ms = Date.now() - t0;
    const hit = (await chatSpend()) === spentBefore;
    if (hit) cacheHits++;
    if (res.escalated) escalated++;
    byModel[res.model] = (byModel[res.model] ?? 0) + 1;
    perQuestion.push({ question: item.question, kind: item.kind, model: res.model, cacheHit: hit, escalated: res.escalated, ms });
    process.stdout.write(`\r  ${i + 1}/${plan.length} (${escalated} escalated, ${cacheHits} cache hits)   `);
  }
  process.stdout.write("\n");

  const after = await readLedger();
  const delta = ledgerDelta(before, after);
  const row: StepResult = {
    step: tau === null ? step : `${step}@${tau}`,
    startedAt: startedAt.toISOString(),
    minutes: Math.round(((Date.now() - startedAt.getTime()) / 60000) * 10) / 10,
    cascadeEnabled: cascadeOn,
    serve,
    threshold: tau,
    asked: plan.length,
    cacheHits,
    escalated,
    byModel,
    before,
    after,
    deltaSpendUsd: delta.spendUsd,
    deltaSavingsUsd: delta.savings,
    perQuestion,
  };
  const rows = loadProgress().filter((r) => r.step !== row.step);
  rows.push(row);
  saveProgress(rows);

  console.log(`spend $${delta.spendUsd.toFixed(4)} over ${plan.length} questions ` +
    `($${(delta.spendUsd / plan.length).toFixed(5)}/answer)`);
  console.log("savings delta:", Object.entries(delta.savings).map(([k, v]) => `${k} $${v.toFixed(4)}`).join(", ") || "(none)");
  console.log("models:", JSON.stringify(byModel), "| escalated", escalated, "| cache hits", cacheHits);
}

// --- calibration -----------------------------------------------------------

async function runJudge(limit: number): Promise<void> {
  const space = await inScope(async () => spaceOf(resolveKeyModel(null)));
  console.log(`judging space ${space}…`);
  const result = await inScope(() =>
    judgeShadowEvents({
      space,
      model: appConfig.semanticCache.judgeBulkModel,
      limit,
      // Re-label prior LLM verdicts too. The corrected prompt has to be applied to
      // the whole set or the curve mixes two rubrics; human verdicts still win.
      rejudge: true,
    }),
  );
  console.log(result);
}

// THE JUDGE ANSWERS A DIFFERENT QUESTION THAN THE SWEEP NEEDS. Its prompt asks
// whether the stored answer is "acceptable, correct, and sufficiently complete"
// for the new question — absolute answer quality. The sweep reads each verdict as
// "was this a false cache HIT", i.e. did semantic proximity serve the wrong
// answer. Those diverge whenever the banked answer is simply a bad answer: the
// cache reproduced faithfully what a miss would have generated anyway, and the
// judge rejects it.
//
// One case settles that divergence without any judgement call: new_query is
// BYTE-IDENTICAL to matched_query. A cache cannot mis-match a question against
// itself, so such a row is a non-false-hit by construction whatever the answer's
// quality. Those and only those are re-labeled here — anything requiring an
// opinion is left exactly as the judge left it, which keeps every recommended τ
// conservative rather than tuned toward a nicer number.
async function adjudicate(): Promise<void> {
  const rows = await sql<{ id: string; sim: string; new_query: string }[]>`
    select id, sim, new_query from semantic_cache_shadow
    where verdict = 'reject' and new_query = matched_query`;
  if (rows.length === 0) {
    console.log("no identical-text rejects to adjudicate");
    return;
  }
  for (const r of rows) {
    console.log(`accept (identical text, sim ${Number(r.sim).toFixed(4)}): ${r.new_query.slice(0, 80)}`);
    await inScope(() => setHumanVerdict(r.id, "accept"));
  }
  console.log(`re-labeled ${rows.length} row(s) as accept on the identical-text tautology`);
}

async function runSweep(): Promise<void> {
  const report = await inScope(async () => {
    const space = spaceOf(resolveKeyModel(null));
    return calibrationCurve(space, await scopedAcceptTarget());
  });
  console.log(`space ${report.space} | target ${report.targetSource.target} | recommended τ ${report.recommended ?? "(none)"}`);
  console.log(`judged ${report.totalJudged} (${report.totalAccepts} accept) | ` +
    `coverage@τ ${report.coverageAtRecommended ?? "—"} | precision@τ ${report.precisionAtRecommended ?? "—"} | ` +
    `attainability ${JSON.stringify(report.attainability)}`);
  // The curve IS the sweep: each row is "serve everything at or above this cosine",
  // so acceptRate is precision (1 − false-hit rate) and coverage is the share of
  // servable traffic captured. The knee is where the first stops paying for the second.
  console.log("\n" + "sim".padEnd(9) + "n".padStart(5) + "precision".padStart(12) + "coverage".padStart(11));
  for (const p of report.curve) {
    console.log(
      p.sim.toFixed(4).padEnd(9),
      String(p.n).padStart(4),
      ((p.acceptRateAtOrAbove * 100).toFixed(1) + "%").padStart(11),
      ((p.coverageAtOrAbove * 100).toFixed(1) + "%").padStart(10),
    );
  }
  writeFileSync("docs/resume-metrics-8-sweep.json", JSON.stringify(report, null, 2) + "\n");
  console.log("wrote docs/resume-metrics-8-sweep.json");
}

async function status(): Promise<void> {
  for (const r of loadProgress()) {
    console.log(
      r.step.padEnd(16),
      `n=${r.asked}`.padEnd(7),
      `spend=$${r.deltaSpendUsd.toFixed(4)}`.padEnd(18),
      `hits=${r.cacheHits}`.padEnd(10),
      `esc=${r.escalated}`.padEnd(8),
      Object.entries(r.deltaSavingsUsd).map(([k, v]) => `${k}:$${v.toFixed(4)}`).join(" "),
    );
  }
  const [cfg] = await sql<{ cascade_enabled: boolean; batch_savings: { semanticCache?: unknown } }[]>`
    select cascade_enabled, batch_savings from configs where id = ${CONFIG_ID}`;
  console.log("\nlevers now:", "cascade", cfg.cascade_enabled, "| cache", JSON.stringify(cfg.batch_savings.semanticCache));
}

// --- entry -----------------------------------------------------------------

async function main(): Promise<void> {
  await loadOwner();
  const [verb, arg] = process.argv.slice(2);
  switch (verb) {
    case "questions": await drawQuestions(); break;
    case "questions2": await drawSecondMix(arg ? Number(arg) : 2); break;
    case "run": await runStep(arg, process.argv[4] ? Number(process.argv[4]) : null, process.argv[5] ? Number(process.argv[5]) : 2); break;
    case "judge": await runJudge(arg ? Number(arg) : 200); break;
    case "adjudicate": await adjudicate(); break;
    case "sweep": await runSweep(); break;
    case "status": await status(); break;
    default:
      console.log("verbs: questions | questions2 | run <baseline|cascade|mix|serve> [tau] | judge [limit] | adjudicate | sweep | status");
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
