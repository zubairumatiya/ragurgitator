// FOLLOW-UP F2 — is the 0.80 shadow-log floor conservative, or already past the edge?
//
//   npm run f2 -- probe          re-run F1's below-floor variants with the floor OFF
//   npm run f2 -- judge [limit]  LLM-judge the rows that produced
//   npm run f2 -- check          judge-vs-construction, sub-floor rows only
//   npm run f2 -- adjudicate     dump the disagreements to fill in by hand
//   npm run f2 -- apply-truth    set the FINAL labels as human verdicts
//   npm run f2 -- band           what each candidate floor would have made visible
//   npm run f2 -- status         what exists so far
//
// WHY. config.semanticCache.shadowLogFloor bounds what calibration can ever see: a
// lookup whose best match falls below it records nothing, so the precision curve
// simply stops at 0.80 and the shape of the region below is unknown. F1 turned that
// from a hypothesis into a number — 29 of its 240 probes (12%) fell below the floor
// and are permanently invisible, INCLUDING hard negatives, whose position down there
// is itself evidence about the floor.
//
// THE DECISION THIS RUN EXISTS TO INFORM is "lower the floor, or log a random sample
// below it". Both are cheap; which is right depends on what is actually down there,
// so this measures FIRST and neither option is presupposed. In particular the floor
// is NOT lowered in config to run this — semanticCacheLookup takes a per-call
// `shadow` override, so the probes see floor 0 while live traffic keeps 0.80.
//
// The rows it writes are stamped origin = 'probe' (0069), so they stay out of the
// live threshold recommendation exactly like F1's. That column is why this run can
// be additive rather than a second contamination of the traffic curve.
//
// The input is F1's probe file: the 29 variants it recorded as logged = false are
// precisely the ones that fell below the floor. Re-probing the WHOLE file is
// deliberate and costs nothing extra — the other 211 dedupe against their existing
// row via `on conflict do nothing` and their key embeddings are already in
// embedding_cache — and it keeps this run from depending on F1's readback having
// been complete.
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

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: "require", max: 2 });
const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

const F1_PROBES = "docs/resume-metrics-f1-probes.json";
const RESULTS = "docs/resume-metrics-f2-probes.json";
const ADJUDICATIONS = "docs/resume-metrics-f2-adjudications.json";

// Floors worth pricing in the `band` report. 0.80 is today's; the rest are the
// candidates a "lower it" decision would choose between.
const CANDIDATE_FLOORS = [0.8, 0.75, 0.7, 0.6, 0.5, 0];

type Probe = {
  text: string;
  label: "same" | "different"; // ground truth by construction
  difficulty: "paraphrase" | "hard-negative";
  originText: string;
  // F1's readback: false means it fell below the floor, which is what F2 re-probes.
  logged?: boolean;
  // Filled by this run's `probe`.
  sim?: number | null;
  matchedQuery?: string | null;
  guardBlocked?: boolean | null;
  subFloor?: boolean; // newly visible: below 0.80, so F1 could not see it
};

const USER = { id: "", email: "" };

const sha256 = async (text: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
};

const loadF1 = (): Probe[] => {
  if (!existsSync(F1_PROBES)) throw new Error(`missing ${F1_PROBES} — F2 re-probes F1's set`);
  return JSON.parse(readFileSync(F1_PROBES, "utf8"));
};

function loadResults(): Probe[] {
  if (!existsSync(RESULTS)) throw new Error(`run "probe" first — ${RESULTS} missing`);
  return JSON.parse(readFileSync(RESULTS, "utf8"));
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

// --- probe ------------------------------------------------------------------

// Same contract as F1's probe pass — the REAL lookup, serving off, nothing banked —
// with the shadow floor dropped to 0 for these calls only. Anything that lands
// below appConfig.semanticCache.shadowLogFloor is a row calibration has never been
// able to see, and is flagged `subFloor` for the band report.
//
// RESUMABLE: a variant that already has a shadow row is skipped. The insert dedupes
// on (config, fingerprint, query_hash) anyway, so re-probing it would change
// nothing — and the first run proved the pass needs to survive interruption, having
// lost one probe to a pooler CONNECTION_CLOSED at 238/240. Re-running now costs the
// handful of lookups that are actually missing.
async function probe(): Promise<void> {
  const floor = appConfig.semanticCache.shadowLogFloor;
  const probes: Probe[] = loadF1().map((p) => ({ ...p, sim: undefined, matchedQuery: undefined }));
  const missing = probes.filter((p) => !p.logged).length;
  console.log(`re-probing ${probes.length} variants with the floor OFF (${missing} were below ${floor} in F1)…`);

  const existing = new Set(
    (
      await sql<{ new_query_hash: string }[]>`
        select new_query_hash from semantic_cache_shadow where config_id = ${CONFIG_ID}`
    ).map((r) => r.new_query_hash),
  );
  let skipped = 0;

  for (const [i, p] of probes.entries()) {
    if (existing.has(await sha256(p.text))) {
      skipped++;
      continue;
    }
    try {
      await inScope(() =>
        semanticCacheLookup(p.text, {
          serve: false,
          threshold: null,
          keyModel: null,
          shadow: { floor: 0, origin: "probe" },
        }),
      );
    } catch (err) {
      console.warn(`\n  probe ${i} failed: ${(err as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${probes.length}   `);
  }
  process.stdout.write("\n");
  if (skipped > 0) console.log(`skipped ${skipped} that already had a shadow row`);

  // The row is the authority, as in F1: the lookup reports a miss with no sim when
  // serving is off, and the row is what calibration reads.
  let recorded = 0;
  for (const p of probes) {
    const hash = await sha256(p.text);
    const [row] = await sql<{ sim: string; matched_query: string; guard_blocked: boolean }[]>`
      select sim, matched_query, guard_blocked from semantic_cache_shadow
      where config_id = ${CONFIG_ID} and new_query_hash = ${hash}
      order by created_at desc limit 1`;
    p.sim = row ? Number(row.sim) : null;
    p.matchedQuery = row?.matched_query ?? null;
    p.guardBlocked = row?.guard_blocked ?? null;
    p.subFloor = row ? Number(row.sim) < floor : false;
    if (row) recorded++;
  }
  writeFileSync(RESULTS, JSON.stringify(probes, null, 2) + "\n");

  const sub = probes.filter((p) => p.subFloor);
  const truth = sub.filter((p) => p.matchedQuery === p.originText);
  console.log(`${recorded}/${probes.length} now have a shadow row (F1 had ${probes.filter((p) => p.logged).length})`);
  console.log(`${sub.length} sit BELOW ${floor} — newly visible; ${truth.length} matched their own origin, so their constructed label is usable`);
  if (sub.length > 0) {
    const sims = sub.map((p) => p.sim!).sort((a, b) => a - b);
    console.log(`sub-floor sim range ${sims[0].toFixed(4)} … ${sims[sims.length - 1].toFixed(4)}`);
  }
  // A probe with STILL no row has no nearest neighbour at all under the live
  // fingerprint — the dead-origin case F1 found, not a floor effect.
  const none = probes.filter((p) => p.sim === null).length;
  if (none > 0) console.log(`${none} recorded nothing even at floor 0 (no reachable cache entry — not a floor effect)`);
  console.log(`wrote ${RESULTS}`);
}

// --- judge / check / truth --------------------------------------------------

type Joined = Probe & { verdict: "accept" | "reject" | null; judgeReason: string | null };

// Truth-valid rows only, same rule as F1: the constructed label describes the pair
// (variant, ORIGIN), so it says nothing about a row that matched something else.
async function joinVerdicts(): Promise<{ sub: Joined[]; truth: Joined[] }> {
  const all: Joined[] = [];
  for (const p of loadResults()) {
    if (!p.subFloor) continue;
    const hash = await sha256(p.text);
    const [row] = await sql<{ verdict: "accept" | "reject" | null; judge_reason: string | null }[]>`
      select verdict, judge_reason from semantic_cache_shadow
      where config_id = ${CONFIG_ID} and new_query_hash = ${hash}
      order by created_at desc limit 1`;
    all.push({ ...p, verdict: row?.verdict ?? null, judgeReason: row?.judge_reason ?? null });
  }
  return { sub: all, truth: all.filter((r) => r.matchedQuery === r.originText) };
}

const expected = (label: "same" | "different") => (label === "same" ? "accept" : "reject");

async function judge(limit: number): Promise<void> {
  const space = await inScope(async () => spaceOf(resolveKeyModel(null)));
  // simMax stops this from re-judging anything F1 already settled: the new rows are
  // exactly the ones below the floor, and every F1 row sits above it.
  const result = await inScope(() =>
    judgeShadowEvents({
      space,
      model: appConfig.semanticCache.judgeBulkModel,
      simMax: appConfig.semanticCache.shadowLogFloor,
      limit,
    }),
  );
  console.log(result);
}

async function check(): Promise<void> {
  const { sub, truth } = await joinVerdicts();
  const judged = truth.filter((r) => r.verdict !== null);
  console.log(`${sub.length} sub-floor rows | ${truth.length} truth-valid | ${judged.length} judged`);
  if (judged.length === 0) {
    console.log('nothing judged yet — run "judge"');
    return;
  }
  const cell = (label: "same" | "different", verdict: "accept" | "reject") =>
    judged.filter((r) => r.label === label && r.verdict === verdict).length;
  const agree = judged.filter((r) => r.verdict === expected(r.label)).length;
  console.log("\n              judge:accept  judge:reject");
  console.log(`constructed same   ${String(cell("same", "accept")).padStart(8)}${String(cell("same", "reject")).padStart(14)}`);
  console.log(`constructed diff   ${String(cell("different", "accept")).padStart(8)}${String(cell("different", "reject")).padStart(14)}`);
  console.log(`\nagreement ${((agree / judged.length) * 100).toFixed(1)}% (${agree}/${judged.length})`);

  console.log(`\n--- every sub-floor row (n=${judged.length}) ---`);
  for (const r of [...judged].sort((a, b) => b.sim! - a.sim!)) {
    const flag = r.verdict === expected(r.label) ? "  " : "!!";
    console.log(`${flag} sim ${r.sim!.toFixed(4)} ${r.difficulty.padEnd(14)} truth=${expected(r.label).padEnd(6)} judge=${String(r.verdict).padEnd(6)}`);
    console.log(`     origin:  ${r.originText}`);
    console.log(`     variant: ${r.text}`);
    if (r.judgeReason) console.log(`     judge:   ${r.judgeReason.slice(0, 160)}`);
  }
}

type Adjudication = { text: string; label: "same" | "different"; why: string };

function loadAdjudications(): Map<string, Adjudication> {
  if (!existsSync(ADJUDICATIONS)) return new Map();
  const rows: Adjudication[] = JSON.parse(readFileSync(ADJUDICATIONS, "utf8"));
  return new Map(rows.filter((r) => r.label).map((r) => [r.text, r]));
}

// F1 established that BOTH sides are fallible — the generator wrote 8 of the 12
// labels it disagreed with the judge on wrongly, the judge 4 — so the hand pass is
// a precondition here too, enforced by apply-truth rather than trusted.
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
  }
  console.log(`wrote ${written} final labels as human verdicts (${fromAdjudication} from hand adjudication, ${written - fromAdjudication} constructed)`);
}

// --- band: the answer to "lower it, or sample below it" ----------------------

// What each candidate floor buys, priced in rows and in what those rows say. A
// floor is worth lowering to X if the band between X and 0.80 contains ACCEPTS —
// matches a threshold could legitimately serve, which calibration currently can't
// see. A band that is all rejects means 0.80 is conservative: nothing down there
// was ever going to be served, and logging it only adds judge cost.
async function band(): Promise<void> {
  const space = await inScope(async () => spaceOf(resolveKeyModel(null)));
  const rows = await sql<{ sim: string; verdict: string | null; origin: string }[]>`
    select sim, verdict, origin from semantic_cache_shadow
    where config_id = ${CONFIG_ID} and space = ${space}
    order by sim desc`;
  const live = appConfig.semanticCache.shadowLogFloor;

  console.log(`space ${space} | ${rows.length} shadow rows (${rows.filter((r) => r.origin === "probe").length} probe)`);
  console.log("\nfloor     rows≥floor   judged   accept   reject   gained vs 0.80");
  const at = (f: number) => rows.filter((r) => Number(r.sim) >= f);
  const base = at(live).length;
  for (const f of CANDIDATE_FLOORS) {
    const set = at(f);
    const judged = set.filter((r) => r.verdict !== null);
    console.log(
      f.toFixed(2).padEnd(10) +
        String(set.length).padStart(8) +
        String(judged.length).padStart(9) +
        String(judged.filter((r) => r.verdict === "accept").length).padStart(9) +
        String(judged.filter((r) => r.verdict === "reject").length).padStart(9) +
        String(set.length - base).padStart(17),
    );
  }

  // The sub-floor band on its own — the rows the current floor hides. This is the
  // number the decision turns on, and the test is NOT "are there any accepts down
  // there". A τ is only ever placed where P(accept | sim ≥ τ) clears the target, so
  // what matters is the band's PRECISION: a band well under the target cannot host a
  // τ no matter how many accepts it contains, and logging it buys judge cost and
  // nothing else. (An earlier version of this readout fired on a single accept and
  // said "lower the floor", which is the wrong criterion.)
  const target = (await inScope(() => scopedAcceptTarget())).target;
  const sub = rows.filter((r) => Number(r.sim) < live);
  const judged = sub.filter((r) => r.verdict !== null);
  const accepts = judged.filter((r) => r.verdict === "accept");
  const precision = judged.length > 0 ? accepts.length / judged.length : null;
  console.log(`\nBELOW ${live}: ${sub.length} rows, ${judged.length} judged, ${accepts.length} accept / ${judged.length - accepts.length} reject`);
  if (precision === null) {
    console.log("→ nothing judged below the floor yet.");
  } else if (precision >= target) {
    console.log(`→ band precision ${(precision * 100).toFixed(1)}% clears the ${(target * 100).toFixed(0)}% target: the floor IS truncating a usable region. Lower it.`);
  } else {
    console.log(`→ band precision ${(precision * 100).toFixed(1)}% against a ${(target * 100).toFixed(0)}% target: no τ can sit in this region, so the floor hides nothing the sweep could use.`);
    console.log("  Lowering it buys judge cost and rejects. A small random sample below the floor is enough to notice if that ever changes.");
  }

  // Both curves side by side, so the effect of the new rows on the recommendation
  // is visible rather than asserted.
  for (const origin of ["traffic", "probe", "all"] as const) {
    const report = await inScope(async () =>
      calibrationCurve(space, await scopedAcceptTarget(), { origin }),
    );
    console.log(
      `curve[${origin.padEnd(7)}] judged ${String(report.totalJudged).padStart(4)} | ` +
        `accepts ${String(report.totalAccepts).padStart(4)} | τ ${report.recommended ?? "(none)"}`,
    );
  }
}

async function status(): Promise<void> {
  if (!existsSync(RESULTS)) {
    console.log(`no ${RESULTS} yet — start with "probe"`);
  } else {
    const probes = loadResults();
    const sub = probes.filter((p) => p.subFloor);
    console.log(`probes ${probes.length} | sub-floor ${sub.length} | truth-valid ${sub.filter((p) => p.matchedQuery === p.originText).length}`);
  }
  const [row] = await sql<{ total: string; judged: string; sub: string; subjudged: string }[]>`
    select count(*) as total, count(verdict) as judged,
           count(*) filter (where sim < ${appConfig.semanticCache.shadowLogFloor}) as sub,
           count(*) filter (where sim < ${appConfig.semanticCache.shadowLogFloor} and verdict is not null) as subjudged
    from semantic_cache_shadow where config_id = ${CONFIG_ID}`;
  console.log(`shadow rows ${row.total} | judged ${row.judged} | below floor ${row.sub} (${row.subjudged} judged)`);
}

async function main(): Promise<void> {
  await loadOwner();
  const [verb, arg] = process.argv.slice(2);
  switch (verb) {
    case "probe": await probe(); break;
    case "judge": await judge(arg ? Number(arg) : 100); break;
    case "check": await check(); break;
    case "adjudicate": await adjudicateTemplate(); break;
    case "apply-truth": await applyTruth(); break;
    case "band": await band(); break;
    case "status": await status(); break;
    default:
      console.log(" verbs: probe | judge [limit] | check | adjudicate | apply-truth | band | status");
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
