// Drive Phase 10 — did the cheap tier actually ANSWER the question?
// Design and rationale: docs/resume-metrics-phase10-plan.md
//
//   npm run phase10 -- plan            freeze the judging manifest (no LLM spend)
//   npm run phase10 -- regen           regenerate the 3 discarded cheap answers
//   npm run phase10 -- judge [limit]   grade the manifest (resumable)
//   npm run phase10 -- report          M1 / M2 / M3
//
// WHAT THIS MEASURES. Phase 9 compared receipts: two arms over the same 100
// questions, −62.7% per answer. Nobody read the answers. The efficacy gate cannot
// certify its own output — it is the component that decided not to escalate — and
// it never reads the question at all (responseEfficacyGate takes `_question` and
// ignores it). So "at the same quality" currently rests on nothing.
//
// NOT PAIRWISE. The withdrawn design asked which of two answers was better. The
// strong model wins on prose even where both are correct, so a loss rate
// overstates the gap for the decision actually at hand ("can the cheap tier carry
// this workload"). Each cheap answer is graded ALONE for sufficiency.
//
// THE ARM IS THE FINGERPRINT, NOT llm_model. semanticCacheStore writes
// cfg.llmModel — the CONFIG's model — so both arms bank `claude-sonnet-4-6` in
// that column. The model that actually answered is result->>'model', and the arm
// is the fingerprint (cascadeEnabled is part of currentFingerprint). Filtering on
// llm_model would silently select the wrong set.
//
// SCOPED TO THE FROZEN QUESTION LISTS. The cache also holds rows from Phase 8's
// mix and serve steps — 241 cheap-tier rows against the 97 that belong to the
// chat arms, and 10 escalations against the 3. The manifest joins on query_text
// against the two frozen files, which is the only honest boundary.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";
import { withUser } from "../lib/auth/userScope";
import { cheapModelFor } from "../lib/config";
import { resolveConfig, withConfig, activeConfig } from "../lib/rag/activeConfig";
import { generateAnswer } from "../lib/rag/generator";
import type { RetrievedChunk } from "../types/rag";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: sslFor(process.env.DATABASE_URL!), max: 2 });
const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

const Q8 = "docs/resume-metrics-8-questions.json";
const Q9 = "docs/resume-metrics-9-questions.json";
const NEGATIVES = "docs/resume-metrics-phase10-negatives.json";
const MANIFEST = process.env.PHASE10_MANIFEST ?? "docs/resume-metrics-10-manifest.json";

// Deterministic so a re-plan reproduces the same ordering and a verdict written
// against item i still describes item i.
const SHUFFLE_SEED = 20260826;

// Override spaces to drop from PLANT retrieval only. See the note in buildPlan
// for what excluding a space costs and why it is the conservative direction.
// Empty this list once every provider is reachable.
const EXCLUDED_SPACES = (process.env.PHASE10_EXCLUDE_SPACES ?? "text-embedding-3-large")
  .split(",").map((m) => m.trim()).filter(Boolean);

const USER = { id: "", email: "" };

type Kind = "cheap" | "plant" | "escalated";

type Item = {
  id: string;              // stable: kind + sha256(question)[0..12]
  kind: Kind;
  question: string;
  answer: string;
  sources: RetrievedChunk[];
  answeredBy: string | null;  // null until `regen` fills an escalated row
  failureMode?: string;       // plants only — NEVER sent to the judge
  verdict?: "sufficient" | "insufficient";
  reason?: string;
  judgeModel?: string;
  promptHash?: string;
  judgedAt?: string;
};

// --- the rubric ------------------------------------------------------------
//
// Deliberately NOT the gate's question, and deliberately not JUDGE_SYSTEM's.
// JUDGE_SYSTEM asked whether an answer was "acceptable, correct and sufficiently
// complete" while showing only the answer — which grades answer QUALITY where
// that task needed match correctness, and read 82% precision at cosine 1.0 where
// a false hit is impossible. The target here is sufficiency AGAINST THE QUESTION
// ASKED, with the sources in view, and the accept/reject boundary is stated in
// both directions so terseness is not mistaken for insufficiency.
const JUDGE_SYSTEM = `You are grading whether an answer produced by a retrieval-augmented system sufficiently answers the question it was asked.

You will be shown THE QUESTION, THE SOURCES the system retrieved, and THE ANSWER it produced.

Reply "sufficient" when the answer addresses what was actually asked, and what it asserts is supported by the sources.

Reply "insufficient" when any of the following hold:
- it answers a DIFFERENT question than the one asked, however well
- it discusses the right topic but never delivers the specific thing requested (a figure, a name, a date, a term)
- it contradicts the sources, or states a fact the sources do not support
- it asserts specifics — statistics, attributions, quotations — that appear nowhere in the sources
- it reverses a relationship the sources give in the other direction (who pressured whom, what caused what)
- it attributes a position, act or figure to the wrong party

Do NOT reply "insufficient" merely because the answer is short, plainly written, lacks caveats, or omits background the question did not ask for. A brief, correct, responsive answer is sufficient.

An answer can be entirely TRUE and still be insufficient, if it does not answer the question that was asked. Judge responsiveness first, then support.

Reply with a single JSON object and nothing else:
{"verdict": "sufficient" | "insufficient", "reason": "<one sentence>"}`;

const PROMPT_HASH = createHash("sha256").update(JUDGE_SYSTEM).digest("hex").slice(0, 12);

// --- scope -----------------------------------------------------------------

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

// --- manifest --------------------------------------------------------------

// On disk: { items, report? }. A bare array is the pre-report shape and still
// loads, so a manifest built by an earlier run needs no migration.
type Manifest = { items: Item[]; report?: Report };

function loadFile(): Manifest {
  if (!existsSync(MANIFEST)) throw new Error(`run "plan" first — ${MANIFEST} missing`);
  const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return Array.isArray(raw) ? { items: raw } : raw;
}

function loadManifest(): Item[] {
  return loadFile().items;
}

// Writing items INVALIDATES any stored report — it was computed from the old
// verdicts. Dropping it is the safe direction: a stale report that silently
// disagrees with the items beside it is worse than none.
function saveManifest(items: Item[]): void {
  writeFileSync(MANIFEST, JSON.stringify({ items }, null, 2) + "\n");
}

function saveReport(items: Item[], report: Report): void {
  writeFileSync(MANIFEST, JSON.stringify({ items, report }, null, 2) + "\n");
}

function idFor(kind: Kind, question: string): string {
  return `${kind}-${createHash("sha256").update(question).digest("hex").slice(0, 12)}`;
}

// mulberry32 — same generator phase8 uses for its draws, so "deterministic" means
// the same thing across the two scripts.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  const rand = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- plan ------------------------------------------------------------------

async function buildPlan(): Promise<void> {
  const frozen: string[] = [
    ...JSON.parse(readFileSync(Q8, "utf8")).chat.map((q: { question: string }) => q.question),
    ...JSON.parse(readFileSync(Q9, "utf8")).chat.map((q: { question: string }) => q.question),
  ];
  if (new Set(frozen).size !== frozen.length) throw new Error("frozen question lists overlap");

  const rows = await sql<{
    query_text: string;
    result: { answer: string; sources: RetrievedChunk[]; model: string; escalated: boolean };
  }[]>`
    select query_text, result from semantic_cache
    where config_id = ${CONFIG_ID} and query_text = any(${frozen})`;

  const cheapModel = cheapModelFor((await sql<{ llm_model: string }[]>`
    select llm_model from configs where id = ${CONFIG_ID}`)[0].llm_model);

  const items: Item[] = [];
  const seen = new Set<string>();
  let escalatedCount = 0;

  for (const q of frozen) {
    const forQ = rows.filter((r) => r.query_text === q).map((r) => r.result);
    const cheap = forQ.find((r) => r.model === cheapModel && !r.escalated);
    const escalated = forQ.find((r) => r.escalated);

    if (cheap) {
      items.push({ id: idFor("cheap", q), kind: "cheap", question: q,
        answer: cheap.answer, sources: cheap.sources, answeredBy: cheap.model });
      seen.add(q);
    } else if (escalated) {
      // M3. The cheap answer the gate rejected was overwritten by the strong one
      // (pipeline.ts answerWithCascade) and never banked — `regen` fills it. The
      // SOURCES survive on the escalated row, and they are the same ones the gate
      // scored, so regeneration reproduces what was actually judged rather than
      // whatever retrieval returns today.
      items.push({ id: idFor("escalated", q), kind: "escalated", question: q,
        answer: "", sources: escalated.sources, answeredBy: null });
      escalatedCount++;
      seen.add(q);
    }
  }

  const missing = frozen.filter((q) => !seen.has(q));
  if (missing.length) throw new Error(`${missing.length} frozen question(s) have no banked answer`);

  const negatives = JSON.parse(readFileSync(NEGATIVES, "utf8")).items as
    { question: string; answer: string; failure_mode: string }[];
  let plantFailures = 0;
  for (const n of negatives) {
    // A plant needs the sources a real ask would have retrieved, or the judge
    // grades it on a different basis than the 97 — and an empty source block is
    // itself a signal.
    //
    // EXCLUDED_SPACES. retrieve() fans out across every per-chunk override space
    // (fuseWithOverrides), so it needs every provider reachable. api.openai.com is
    // not reachable from the dev host and there is no OPENAI_API_KEY, so the
    // text-embedding-3-large lane is dropped by filtering the override state that
    // retrieveWithCutoffs accepts via `ctx` — no retriever change, no mutation of
    // config_chunk_overrides.
    //
    // WHAT THIS COSTS, stated so it is not rediscovered as a bug: the 97 were
    // retrieved with ALL lanes open. Dropping one means the plants are retrieved
    // under a marginally different regime. It is 5 chunks of 232 (2%), and it can
    // only remove candidates from the merge, never reorder the lanes that remain
    // — so a plant's sources are a subset-or-equal of what a full run would give
    // it. That is the conservative direction for M2: it can make a plant slightly
    // easier to reject for lack of support, never harder. If OpenAI access is
    // restored, delete EXCLUDED_SPACES and re-run `plan` for exact parity.
    let sources: RetrievedChunk[] = [];
    try {
      sources = await inScope(async () => {
        const { embedQuery } = await import("../lib/rag/embeddings");
        const { retrieveForQuery, buildRetrievalContext } = await import("../lib/rag/retriever");
        const ctx = await buildRetrievalContext();
        const overrides = ctx.overrides.filter((o) => !EXCLUDED_SPACES.includes(o.model));
        const dropped = ctx.overrides.length - overrides.length;
        if (dropped) process.stdout.write(`(-${dropped} chunk(s) in excluded spaces) `);
        return retrieveForQuery(n.question, await embedQuery(n.question), undefined, { ...ctx, overrides });
      });
    } catch (e) {
      plantFailures++;
      console.log(`\n  !! retrieval failed for a plant: ${(e as Error).message.slice(0, 80)}`);
    }
    items.push({ id: idFor("plant", n.question), kind: "plant", question: n.question,
      answer: n.answer, sources, answeredBy: null, failureMode: n.failure_mode });
  }

  // Idempotent. A re-run exists to top up what an earlier pass could not build
  // (a plant whose retrieval failed), so anything already judged is carried over
  // verbatim and the frozen order is preserved. Reshuffling here would silently
  // re-point every verdict at a different item.
  const prior = existsSync(MANIFEST) ? loadManifest() : [];
  const byId = new Map(prior.map((i) => [i.id, i]));
  const merged = items.map((fresh) => {
    const old = byId.get(fresh.id);
    if (!old) return fresh;
    return {
      ...old,
      // the only fields a re-run may legitimately fill in
      sources: old.sources.length ? old.sources : fresh.sources,
      answer: old.answer || fresh.answer,
    };
  });
  const shuffled = prior.length
    ? prior.map((p) => merged.find((m) => m.id === p.id) ?? p)
        .concat(merged.filter((m) => !byId.has(m.id)))
    : shuffle(merged, SHUFFLE_SEED);
  saveManifest(shuffled);
  const sourceless = shuffled.filter((i) => i.kind === "plant" && !i.sources.length).length;
  if (sourceless) console.log(`!! ${sourceless} plant(s) have no sources — re-run "plan" where every embedding provider is reachable`);
  console.log(`manifest: ${shuffled.length} items ` +
    `(${items.filter((i) => i.kind === "cheap").length} cheap, ` +
    `${escalatedCount} escalated, ${negatives.length} plants) → ${MANIFEST}`);
  console.log(`prompt hash ${PROMPT_HASH} | shuffled with seed ${SHUFFLE_SEED}`);
}

// --- regen (M3) ------------------------------------------------------------

async function regen(): Promise<void> {
  const items = loadManifest();
  const todo = items.filter((i) => i.kind === "escalated" && !i.answer);
  if (!todo.length) return console.log("nothing to regenerate");

  const cheapModel = await inScope(async () => cheapModelFor(activeConfig().llmModel));
  console.log(`regenerating ${todo.length} cheap answer(s) on ${cheapModel}…`);

  for (const item of todo) {
    // Same sources the gate scored — see the note in buildPlan.
    const gen = await inScope(() => generateAnswer(item.question, item.sources, cheapModel));
    item.answer = gen.answer;
    item.answeredBy = cheapModel;
    saveManifest(items);
    process.stdout.write(".");
  }
  console.log(`\nregenerated ${todo.length}`);
}

// --- judge -----------------------------------------------------------------

function sourceBlock(sources: RetrievedChunk[]): string {
  return sources
    .map((s, i) => `[${i + 1}] ${s.chunk.chunk.text}`)
    .join("\n\n");
}

async function runJudge(limit: number): Promise<void> {
  const items = loadManifest();
  const ready = (i: Item) => i.answer && i.sources.length > 0;
  const todo = items.filter((i) => !i.verdict && ready(i)).slice(0, limit);
  const noAnswer = items.filter((i) => !i.answer).length;
  const noSources = items.filter((i) => i.answer && !i.sources.length).length;
  if (noAnswer) console.log(`!! ${noAnswer} item(s) have no answer — run "regen" first`);
  if (noSources) console.log(`!! ${noSources} item(s) have no sources — re-run "plan"; judging them on an empty source block would manufacture rejections`);
  if (!todo.length) return console.log("nothing to judge");

  const { meteredMessage } = await import("../lib/rag/meter");
  const model = "claude-sonnet-4-6";
  console.log(`judging ${todo.length} item(s) on ${model} (prompt ${PROMPT_HASH})…`);

  let done = 0;
  for (const item of todo) {
    // failureMode is bookkeeping and stays out of the prompt — sending it would
    // hand the judge the answer to the question we are asking it.
    const user =
      `THE QUESTION\n${item.question}\n\n` +
      `THE SOURCES\n${sourceBlock(item.sources)}\n\n` +
      `THE ANSWER\n${item.answer}`;

    const resp = await inScope(() => meteredMessage("judge", {
      model,
      max_tokens: 300,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: user }],
    }));
    const text = resp.content.map((c) => ("text" in c ? c.text : "")).join("").trim();

    let parsed: { verdict?: string; reason?: string } = {};
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      console.log(`\n!! unparseable verdict for ${item.id}: ${text.slice(0, 120)}`);
      continue; // leave unjudged so a re-run retries it
    }
    if (parsed.verdict !== "sufficient" && parsed.verdict !== "insufficient") {
      console.log(`\n!! bad verdict for ${item.id}: ${String(parsed.verdict)}`);
      continue;
    }

    item.verdict = parsed.verdict;
    item.reason = parsed.reason ?? "";
    item.judgeModel = model;
    item.promptHash = PROMPT_HASH;
    item.judgedAt = new Date().toISOString();
    saveManifest(items); // resumable: a kill mid-run loses at most one call
    done++;
    process.stdout.write(`\r  ${done}/${todo.length}   `);
  }
  console.log(`\njudged ${done}`);
}

// --- report ----------------------------------------------------------------

type Report = {
  generatedAt: string;
  judgeModel: string | null;
  promptHash: string;
  m1: { sufficient: number; of: number; insufficient: { question: string; reason: string }[] };
  m2: { rejected: number; of: number; void: boolean; plants: { failureMode: string; verdict: string; reason: string }[] };
  m3: { unnecessary: number; of: number; escalations: { question: string; verdict: string; reason: string }[] };
  unjudged: number;
};

function report(): void {
  const items = loadManifest();
  const of = (k: Kind) => items.filter((i) => i.kind === k && i.verdict);
  const cheap = of("cheap");
  const plants = of("plant");
  const escalated = of("escalated");

  const suff = (xs: Item[]) => xs.filter((i) => i.verdict === "sufficient").length;

  console.log("\n=== M2 — rubric validity (read this FIRST) ===");
  const caught = plants.filter((i) => i.verdict === "insufficient");
  console.log(`plants rejected: ${caught.length} of ${plants.length}`);
  for (const p of plants) {
    const ok = p.verdict === "insufficient" ? "✓" : "✗ ACCEPTED";
    console.log(`  ${ok}  ${p.failureMode}${p.verdict === "insufficient" ? "" : "  << rubber stamp"}`);
    console.log(`        ${p.reason}`);
  }
  // Item 7's first draft named WWII institutions in a WWI answer and was catchable
  // on surface features; the regenerated one differs only in the figure. Flagged
  // rather than excluded — the plan says to read it as the least informative.
  if (plants.length && caught.length <= plants.length * 0.6) {
    console.log("\n!! M2 FAILED — the rubric accepts planted wrong answers.");
    console.log("!! M1 below is VOID. Fix the prompt and re-judge before quoting anything.");
  }

  console.log("\n=== M1 — cheap-tier sufficiency ===");
  console.log(`sufficient: ${suff(cheap)} of ${cheap.length}`);
  for (const c of cheap.filter((i) => i.verdict === "insufficient")) {
    console.log(`  ✗ ${c.question.slice(0, 90)}`);
    console.log(`      ${c.reason}`);
  }

  console.log("\n=== M3 — gate false positives ===");
  console.log(`escalations the cheap tier could have handled: ${suff(escalated)} of ${escalated.length}`);
  for (const e of escalated) {
    console.log(`  ${e.verdict === "sufficient" ? "✗ did not need escalating" : "✓ correctly escalated"}` +
      `  ${e.question.slice(0, 80)}`);
    console.log(`      ${e.reason}`);
  }

  const unjudged = items.filter((i) => !i.verdict).length;
  if (unjudged) console.log(`\n(${unjudged} item(s) still unjudged)`);

  const row: Report = {
    generatedAt: new Date().toISOString(),
    judgeModel: items.find((i) => i.judgeModel)?.judgeModel ?? null,
    promptHash: PROMPT_HASH,
    m1: {
      sufficient: suff(cheap),
      of: cheap.length,
      insufficient: cheap.filter((i) => i.verdict === "insufficient")
        .map((i) => ({ question: i.question, reason: i.reason ?? "" })),
    },
    m2: {
      rejected: caught.length,
      of: plants.length,
      void: plants.length > 0 && caught.length <= plants.length * 0.6,
      plants: plants.map((i) => ({ failureMode: i.failureMode ?? "", verdict: i.verdict!, reason: i.reason ?? "" })),
    },
    m3: {
      unnecessary: suff(escalated),
      of: escalated.length,
      escalations: escalated.map((i) => ({ question: i.question, verdict: i.verdict!, reason: i.reason ?? "" })),
    },
    unjudged,
  };
  saveReport(items, row);
  console.log(`\nreport written to ${MANIFEST} (key: "report")`);
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const [verb, arg] = process.argv.slice(2);
  await loadOwner();
  switch (verb) {
    case "plan": await buildPlan(); break;
    case "regen": await regen(); break;
    case "judge": await runJudge(arg ? Number(arg) : 1000); break;
    case "report": report(); break;
    default: console.log("verbs: plan | regen | judge [limit] | report");
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
