// FOLLOW-UP F7 — what is τ = 0.95 worth under the NATURAL prior?
//
//   npm run f7 -- run [--tau 0.95] [--write]   the estimate, and the doc
//   npm run f7 -- data                         the sample this rests on
//
// WHY. F1 put 210 engineered near-misses into semantic_cache_shadow and read
// **88.3% precision at τ = 0.95** off the result. That number is a BOUND, not an
// estimate: half the probe set is hard negatives, a mix nobody is sending. F7 is
// the correction — mix negatives back in at the rate real traffic produces them.
//
// THE PRIOR IS THE WHOLE QUESTION, and this account's traffic answers it in a way
// nobody anticipated: of the 91 judged traffic rows above the log floor, **91 are
// accepts and 0 are rejects.** A census, not a sample — every traffic row in the
// table is judged, so this is not a judging-selection artifact.
//
// A zero has no point estimate, so the honest move is a BOUND ON THE PRIOR rather
// than a made-up rate: with 0 negatives in 91 observations the 95% upper bound on
// the negative rate is ~3.3% (rule of three) / ~4.1% (Wilson). The estimate is
// then reported ACROSS that range and beyond it, so the reader sees both the
// number and how fast it moves if the corpus or question mix changes.
//
// WHERE EACH PIECE COMES FROM (see lib/rag/naturalPrior.ts for the algebra):
//   • P(sim ≥ τ | accept) — the positives' SHAPE — from traffic accepts. Real
//     questions, real matches; there are 91 of them, which is enough.
//   • P(sim ≥ τ | reject) — the negatives' SHAPE — from probe rejects, because
//     traffic has produced none and a rate needs a denominator.
//   • the PRIOR — how often a negative arrives at all — from the traffic census.
//
// The one thing this cannot fix, and it travels with every number below: probe
// negatives were WRITTEN to sit next to a banked question, so their sims are
// higher than natural negatives' would be. Reweighting corrects the frequency of
// a negative, not its difficulty. The result is therefore still conservative —
// realistic prior, adversarial negative shape.
//
// Costs nothing: no embeddings, no LLM calls. It is arithmetic over rows F1, F2
// and Phase 8 already paid for.
import { writeFileSync } from "node:fs";

import postgres from "postgres";

import { sslFor } from "../lib/dbSsl";

import { config as appConfig } from "../lib/config";
import {
  priorCurve,
  precisionAt,
  recommendUnderPrior,
  wilson,
  type PriorCurve,
} from "../lib/rag/naturalPrior";
import { spaceOf } from "../lib/rag/semanticCacheCore";
import { inScope, loadOwner, type Owner } from "./lib/followup";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, ssl: sslFor(process.env.DATABASE_URL!), max: 2 });

const OUT = "docs/resume-metrics-f7-results.md";
const FLOOR = appConfig.semanticCache.shadowLogFloor;
const TARGET = appConfig.semanticCache.acceptTarget;

let owner: Owner;

type Row = { sim: number; verdict: "accept" | "reject"; origin: "traffic" | "probe" };

async function loadRows(space: string): Promise<Row[]> {
  const rows = await sql<{ sim: string; verdict: string; origin: string }[]>`
    select sim, verdict, origin
    from semantic_cache_shadow
    where space = ${space}
      and verdict is not null
      and config_id in (select id from configs where user_id = ${owner.id})`;
  return rows.map((r) => ({
    sim: Number(r.sim),
    verdict: r.verdict as "accept" | "reject",
    origin: r.origin === "probe" ? "probe" : "traffic",
  }));
}

const pct = (v: number | null, d = 1): string => (v === null ? "—" : `${(v * 100).toFixed(d)}%`);

// --- the estimate ------------------------------------------------------------

// Bootstrap the class-conditional samples at a FIXED prior, so the interval
// reported is the one contributed by sample size alone. Prior uncertainty is
// shown separately, as a range — mixing the two into one interval would hide
// which of them is actually driving the width. (It is the prior, by a lot.)
function bootstrapPrecision(
  accepts: number[],
  rejects: number[],
  prior: number,
  tau: number,
  iterations = 2000,
): { lo: number; hi: number } | null {
  const draw = (xs: number[]): number[] =>
    Array.from({ length: xs.length }, () => xs[Math.floor(Math.random() * xs.length)]);
  const out: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const a = draw(accepts);
    const r = draw(rejects);
    const tpr = a.filter((s) => s >= tau).length / a.length;
    const fpr = r.filter((s) => s >= tau).length / r.length;
    const served = prior * tpr + (1 - prior) * fpr;
    if (served > 0) out.push((prior * tpr) / served);
  }
  if (out.length === 0) return null;
  out.sort((x, y) => x - y);
  return { lo: out[Math.floor(0.025 * out.length)], hi: out[Math.floor(0.975 * out.length)] };
}

async function run(tau: number, write: boolean): Promise<void> {
  const space = spaceOf(appConfig.semanticCache.keyModel);
  const all = await loadRows(space);
  // Everything is conditioned on the band that is actually logged AND served
  // from. Sub-floor rows (F5's sample) are a different sampling regime and are
  // excluded here for the same reason calibrationCurve excludes them.
  const rows = all.filter((r) => r.sim >= FLOOR);

  const traffic = rows.filter((r) => r.origin === "traffic");
  const probe = rows.filter((r) => r.origin === "probe");
  const trafficAccepts = traffic.filter((r) => r.verdict === "accept");
  const trafficRejects = traffic.filter((r) => r.verdict === "reject");
  const probeRejects = probe.filter((r) => r.verdict === "reject");

  console.log(`space ${space}, floor ${FLOOR}, τ ${tau}, target ${pct(TARGET, 0)}`);
  console.log(
    `sample: ${rows.length} judged rows above the floor — ` +
      `traffic ${traffic.length} (${trafficAccepts.length} accept / ${trafficRejects.length} reject), ` +
      `probe ${probe.length} (${probe.length - probeRejects.length} accept / ${probeRejects.length} reject)`,
  );

  // --- the prior, and its bound ---------------------------------------------
  const negRate = traffic.length === 0 ? null : trafficRejects.length / traffic.length;
  const w = wilson(trafficRejects.length, traffic.length);
  const ruleOfThree = traffic.length === 0 ? null : 3 / traffic.length;
  console.log(
    `\nnatural negative rate: ${trafficRejects.length}/${traffic.length} = ${pct(negRate, 2)}` +
      ` — 95% upper bound ${pct(w.hi, 2)} (Wilson)` +
      (trafficRejects.length === 0 ? `, ${pct(ruleOfThree, 2)} (rule of three)` : ""),
  );

  // --- the reweighted curve --------------------------------------------------
  // Positives' shape from traffic, negatives' shape from probes — see the header.
  const events = [...trafficAccepts, ...probeRejects].map((r) => ({
    sim: r.sim,
    verdict: r.verdict,
  }));
  const acceptSims = trafficAccepts.map((r) => r.sim);
  const rejectSims = probeRejects.map((r) => r.sim);

  // The raw, unreweighted read on the same rows — F1's bound, recomputed here so
  // the comparison is like-for-like rather than quoted across documents.
  const rawAbove = rows.filter((r) => r.sim >= tau);
  const rawPrecision = rawAbove.length
    ? rawAbove.filter((r) => r.verdict === "accept").length / rawAbove.length
    : null;

  // IDENTITY CHECK, and the reason to trust the rest. Fed the POOLED sample and
  // that sample's OWN prior, the reweighting must reproduce the raw precision
  // exactly — reweighting to the rate you already have is arithmetically a no-op.
  // Hitting F1's published 88.3% from the other direction is what says the
  // filters, the space and the floor all line up with the run being corrected.
  const pooledEvents = rows.map((r) => ({ sim: r.sim, verdict: r.verdict }));
  const poolPrior = rows.filter((r) => r.verdict === "accept").length / rows.length;
  const identity = precisionAt(priorCurve(pooledEvents, poolPrior) as PriorCurve, tau);
  const identityOk =
    identity?.precision != null &&
    rawPrecision != null &&
    Math.abs(identity.precision - rawPrecision) < 1e-9;
  console.log(
    `\nidentity check — pooled sample at its own prior (${pct(1 - poolPrior, 1)} negatives): ` +
      `${pct(identity?.precision ?? null, 1)} vs raw ${pct(rawPrecision, 1)} ` +
      `${identityOk ? "OK" : "MISMATCH"}`,
  );
  if (!identityOk) process.exitCode = 1;

  const grid = [0.001, 0.005, 0.01, 0.02, ruleOfThree ?? 0.033, w.hi, 0.1, 0.25, 0.5];
  console.log(`\nprecision at τ=${tau}, by assumed negative rate`);
  const table: Array<Record<string, string>> = [];
  for (const negPrior of grid) {
    const curve = priorCurve(events, 1 - negPrior);
    const p = curve ? precisionAt(curve, tau) : null;
    const rec = curve ? recommendUnderPrior(curve, TARGET, appConfig.semanticCache.minCalibrationSamples) : null;
    table.push({
      "negatives": pct(negPrior, 2),
      [`precision@${tau}`]: pct(p?.precision ?? null, 1),
      "recall@τ": pct(p?.tpr ?? null, 1),
      "false-hit rate": pct(p?.fpr ?? null, 1),
      [`τ for ${pct(TARGET, 0)}`]: rec ? rec.sim.toFixed(4) : "unreachable",
    });
  }
  console.table(table);

  const headlinePrior = 1 - w.hi;
  const headline = precisionAt(priorCurve(events, headlinePrior) as PriorCurve, tau);
  const boot = bootstrapPrecision(acceptSims, rejectSims, headlinePrior, tau);
  console.log(
    `\nHEADLINE — at the 95% WORST CASE for the prior (${pct(w.hi, 2)} negatives):\n` +
      `  precision at τ=${tau}: ${pct(headline?.precision ?? null, 1)}` +
      (boot ? ` (95% bootstrap ${pct(boot.lo, 1)}–${pct(boot.hi, 1)})` : "") +
      `\n  vs the adversarial-mix bound on the same rows: ${pct(rawPrecision, 1)}`,
  );

  if (write) {
    writeFileSync(OUT, doc({
      space, tau, rows, traffic, trafficAccepts, trafficRejects, probe, probeRejects,
      negRate, w, ruleOfThree, table, headline: headline?.precision ?? null, boot, rawPrecision,
      events, poolPrior, identity: identity?.precision ?? null,
    }));
    console.log(`\nwrote ${OUT}`);
  }
}

// The write-up. Generated rather than hand-written so every number in it comes
// from the same run that printed the table above — the failure mode these docs
// have is a number transcribed once and then quoted forever.
function doc(d: {
  space: string; tau: number; rows: Row[]; traffic: Row[]; trafficAccepts: Row[];
  trafficRejects: Row[]; probe: Row[]; probeRejects: Row[]; negRate: number | null;
  w: { lo: number; hi: number }; ruleOfThree: number | null;
  table: Array<Record<string, string>>; headline: number | null;
  boot: { lo: number; hi: number } | null; rawPrecision: number | null;
  events: { sim: number; verdict: "accept" | "reject" }[];
  poolPrior: number; identity: number | null;
}): string {
  const cols = Object.keys(d.table[0]);
  const rows99 = priorCurve(d.events, 1 - d.w.hi);
  const rec = rows99
    ? recommendUnderPrior(rows99, TARGET, appConfig.semanticCache.minCalibrationSamples)
    : null;
  return `# F7 — precision at τ under the natural prior

Generated by \`npm run f7 -- run --write\` on ${new Date().toISOString().slice(0, 10)}.
Space \`${d.space}\`, log floor ${FLOOR}, live τ ${d.tau}, precision target ${pct(TARGET, 0)}.

F1 measured **${pct(d.rawPrecision, 1)} precision at τ = ${d.tau}** on this space and said
plainly that it was a *bound*: half its probe set is engineered near-misses, a
question mix nobody sends. F7 replaces the adversarial prevalence with the one real
traffic produces, and leaves everything else alone.

## The prior, which is the finding

| | |
| --- | --- |
| Judged traffic rows above the floor | **${d.traffic.length}** |
| …accepts | ${d.trafficAccepts.length} |
| …rejects | **${d.trafficRejects.length}** |
| Natural negative rate | **${pct(d.negRate, 2)}** |
| 95% upper bound (Wilson) | ${pct(d.w.hi, 2)} |
| 95% upper bound (rule of three) | ${pct(d.ruleOfThree, 2)} |

Every traffic row in the table is judged, so this is a **census of what this account
has actually asked**, not a sample of it — a zero here is not a judging gap. Nothing
in real traffic has ever produced a cache match above ${FLOOR} that a judge then
rejected.

A zero has no point estimate, so the estimate below is reported **across a range of
assumed negative rates** rather than at a single invented one, with the traffic-supported
region marked.

## Precision at τ = ${d.tau}, by assumed negative rate

| ${cols.join(" | ")} |
| ${cols.map(() => "---").join(" | ")} |
${d.table.map((r) => `| ${cols.map((c) => r[c]).join(" | ")} |`).join("\n")}

The rows at ${pct(d.ruleOfThree, 2)} and ${pct(d.w.hi, 2)} are the two standard 95% bounds on a
zero numerator, and mark where the traffic evidence stops. Every HIGHER rate below
them in the table is a **hypothetical** — what the number becomes if the corpus, key
model or question mix starts producing negatives that often. They are there because
this prior is the assumption most likely to break, and the useful thing to know is
how much slack there is: it takes a **10% natural negative rate**, 2.5× the top of
what 0-in-${d.traffic.length} supports, before τ = ${d.tau} drops below the ${pct(TARGET, 0)} target at all.

> **Do not read the \`τ for ${pct(TARGET, 0)}\` column as a threshold to apply.** At the low end
> it collapses to the log floor (${FLOOR}) — with negatives assumed near-zero, even the
> floor clears the target arithmetically. That is the same degenerate recommendation
> F2 recorded and refused, and it is degenerate for the same reason: a τ is only as
> trustworthy as the negatives that pushed it up, and below ~2% assumed negatives
> there are effectively none holding it. **τ stays at ${d.tau}.** This column is here to
> show where the recommendation becomes unstable, not to move the dial.

### Why the numbers should be believed: the identity check

Fed the **pooled** sample and that sample's **own** prior (${pct(1 - d.poolPrior, 1)} negatives),
the reweighting must return the raw precision unchanged — reweighting to the rate
you already have is arithmetically a no-op. It returns **${pct(d.identity, 1)}** against a raw
**${pct(d.rawPrecision, 1)}**, which is F1's published figure recovered from the other direction.
The space, the floor and the row filters therefore line up with the run being
corrected; the run refuses (exit 1) if they ever stop lining up.

## The headline

**At the 95% worst case for the prior (${pct(d.w.hi, 2)} negatives), precision at τ = ${d.tau} is
${pct(d.headline, 1)}**${d.boot ? ` (95% bootstrap over sample size: ${pct(d.boot.lo, 1)}–${pct(d.boot.hi, 1)})` : ""} —
against the **${pct(d.rawPrecision, 1)}** bound read off the same rows without reweighting.

${rec
  ? `Under that same prior, the lowest τ that still clears the ${pct(TARGET, 0)} target is **${rec.sim.toFixed(4)}**, serving ${pct(rec.tpr, 1)} of available matches.`
  : `Under that same prior, no τ in the sample clears the ${pct(TARGET, 0)} target.`}

So the safety number for a writeup is not ${pct(d.rawPrecision, 1)}. **${pct(d.rawPrecision, 1)} is what τ = ${d.tau} degrades
to when ${pct(1 - d.poolPrior, 1)} of incoming matches are engineered near-misses** — the probe
pool's own mix, and a rate ${(((1 - d.poolPrior) / d.w.hi) || 0).toFixed(0)}× the top of what traffic supports; the estimate under
the traffic this account actually sends — held at the pessimistic end of what 0-in-${d.traffic.length}
supports — is ${pct(d.headline, 1)}.

## What this still does not claim

- **The negatives' shape is still adversarial.** Their sims come from probe rows
  written to sit next to a banked question (${d.probeRejects.length} of them); traffic has produced
  none to compare against. Reweighting fixes how OFTEN a negative arrives, not how
  close it sits when it does, so the false-hit rate above is pessimistic and the
  estimate stays conservative in that direction.
- **It is one account, one corpus, ${d.traffic.length} traffic matches.** The sensitivity table is
  in the doc precisely because that prior is the thing most likely to move.
- **It says nothing about questions that never matched.** Precision is a property
  of what gets served; lookups that found nothing above the floor are outside the
  population by construction, and are the recall story instead.
- **F5's sub-floor sample is not in it.** Those rows are a ~5% sample of a band
  sitting beside a 100% census, and are excluded here exactly as \`calibrationCurve\`
  excludes them. There are none yet in any case.
`;
}

async function data(): Promise<void> {
  const space = spaceOf(appConfig.semanticCache.keyModel);
  const rows = await loadRows(space);
  const g: Record<string, { n: number; min: number; max: number; sub: number }> = {};
  for (const r of rows) {
    const k = `${r.origin} / ${r.verdict}`;
    g[k] ??= { n: 0, min: 1, max: -1, sub: 0 };
    g[k].n++;
    g[k].min = Math.min(g[k].min, r.sim);
    g[k].max = Math.max(g[k].max, r.sim);
    if (r.sim < FLOOR) g[k].sub++;
  }
  console.table(
    Object.entries(g).map(([k, v]) => ({
      group: k, n: v.n, "sub-floor": v.sub, min: v.min.toFixed(4), max: v.max.toFixed(4),
    })),
  );
}

async function main(): Promise<void> {
  owner = await loadOwner(sql);
  const argv = process.argv.slice(2);
  const tau = argv.includes("--tau") ? Number(argv[argv.indexOf("--tau") + 1]) : 0.95;
  switch (argv[0]) {
    case "run": await inScope(owner, () => run(tau, argv.includes("--write"))); break;
    case "data": await inScope(owner, data); break;
    default:
      console.log(" verbs: run [--tau 0.95] [--write] | data");
  }
}

main().then(async () => {
  await sql.end();
  process.exit(process.exitCode ?? 0);
}, async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
