// The semantic cache gate's decision and verdict
// (docs/semantic-cache-gate-plan.md §Phase 2). PURE: the fixture comes in as
// data, the serving path's own functions decide each pair, and the comparison
// with the committed baseline goes out as data.
//
// IMPORT ALLOW-LIST, enforced by cacheGateCore.test.ts: this file may reach
// lib/rag/semanticCacheCore, lib/rag/keyModelSweepCore, lib/config and
// scripts/lib/*. Nothing that opens a database or a provider client. That test
// is what makes "no network, $0" a property of the gate rather than a hope.
//
// THE DECISION IS NOT RE-IMPLEMENTED HERE. `decide` calls cosine, isHit and
// entityGuardPasses in the order semanticCacheLookup calls them, under the same
// config flag. If the decision ever moves out of semanticCacheCore.ts, this gate
// goes blind, and the allow-list test is where that shows up first.
import { config } from "../../lib/config";
import { poolPairs, pairKey, type SweepPair } from "../../lib/rag/keyModelSweepCore";
import { cosine, entityGuardPasses, isHit } from "../../lib/rag/semanticCacheCore";
import { readVec, textHash, type Manifest, type PairLabel } from "./cacheGateFixture";

// Where a decided pair came from. `quarantined` is a generated pair whose label
// a human verdict disproved: poolPairs drops it, and the gate appends it back
// relabelled by that verdict.
export type PairSource = "generated" | "traffic" | "probe" | "quarantined";

// One orientation of the serving call: `question` arrived, `banked` is the row
// it was matched to. `hit` is the similarity test alone; `guard` is whether the
// entity guard lets it through (always true when the guard is disabled).
export type Orientation = { hit: boolean; guard: boolean };

export type Decision = {
  key: string;
  textA: string;
  textB: string;
  truth: PairLabel;
  source: PairSource;
  sim: number;
  // ab: question = textA, banked = textB. ba: the reverse.
  ab: Orientation;
  ba: Orientation;
  // Would the cache serve the banked answer in EITHER role? A stored pair is
  // unordered; the serving path is not.
  served: boolean;
};

export type Aggregates = {
  pairs: number;
  bySource: Record<PairSource, number>;
  // truth different ∧ served — the thing the gate exists to catch.
  falseAccepts: number;
  // truth same ∧ served — cache hits that are right; losing one is cost.
  trueAccepts: number;
  // isHit in some orientation, but the guard vetoed it, and the veto was right.
  guardSaves: number;
};

export type Run = {
  fixtureHash: string;
  keyModel: string;
  keyModelSource: Manifest["keyModelSource"];
  tau: Manifest["tau"];
  guardEnabled: boolean;
  aggregates: Aggregates;
  perPair: Decision[];
};

// Cosines rounded like lib/demo/replayCore's SIM_PRECISION: bit-exact float
// sums are not a promise across Node versions, six decimals are.
const SIM_PRECISION = 1e6;
// Half a rounding unit: the smallest possible move between two rounded sims is
// one unit, and |a - b| for two 6-decimal doubles lands on either side of
// exactly 1e-6 depending on the operands, so `> 1e-6` would miss some of them.
const SIM_DRIFT_TOLERANCE = 0.5 / SIM_PRECISION;
export const roundSim = (x: number): number => Math.round(x * SIM_PRECISION) / SIM_PRECISION;

const expectedVerdict = (label: PairLabel): "accept" | "reject" => (label === "same" ? "accept" : "reject");

// The population: production's own poolPairs over the fixture's three inputs,
// then the quarantined rows appended under the label their human verdict gave
// them (the rule scripts/f6-order.ts uses).
export function population(m: Manifest): Array<{ textA: string; textB: string; truth: PairLabel; source: PairSource }> {
  const survivors = m.generated.filter((g) => g.verdict === null || g.verdict === expectedVerdict(g.label));
  const quarantined = m.generated.filter((g) => g.verdict !== null && g.verdict !== expectedVerdict(g.label));
  const shadow: SweepPair[] = m.shadow.map((s) => ({
    textA: s.textA,
    textB: s.textB,
    label: s.verdict === "accept" ? "same" : "different",
    source: "shadow",
    origin: s.origin,
    difficulty: null,
  }));
  const pooled = poolPairs(
    survivors.map((g) => ({ textA: g.textA, textB: g.textB, label: g.label, difficulty: g.difficulty as SweepPair["difficulty"] })),
    quarantined.map((g) => ({ textA: g.textA, textB: g.textB })),
    shadow,
  );
  // poolPairs drops a PROBE that collides with a quarantined pair but lets a
  // TRAFFIC row through, so a quarantined pair that was later served live would
  // be decided twice under one key, possibly with opposite truths. The pooled
  // row already represents that pair; the quarantine append must not add a
  // second.
  const pooledKeys = new Set(pooled.map((p) => pairKey(p.textA, p.textB)));
  return [
    ...pooled.map((p) => ({
      textA: p.textA,
      textB: p.textB,
      truth: p.label as PairLabel,
      source: (p.source === "generated" ? "generated" : p.origin!) as PairSource,
    })),
    ...quarantined
      .filter((g) => !pooledKeys.has(pairKey(g.textA, g.textB)))
      .map((g) => ({
        textA: g.textA,
        textB: g.textB,
        truth: (g.verdict === "accept" ? "same" : "different") as PairLabel,
        source: "quarantined" as const,
      })),
  ];
}

// semanticCacheLookup's decision for one orientation:
//   guardBlocked = entityGuard.enabled && !entityGuardPasses(question, match.text)
//   hit          = isHit(sim, τ) && !guardBlocked
function orient(question: string, banked: string, sim: number, tau: number, guardEnabled: boolean): Orientation {
  return { hit: isHit(sim, tau), guard: !guardEnabled || entityGuardPasses(question, banked) };
}

export function decideAll(m: Manifest, blob: Buffer): Run {
  const guardEnabled = config.semanticCache.entityGuard.enabled;
  const tau = m.tau.value;
  const vec = new Map<string, number[]>();
  const vecOf = (text: string): number[] => {
    let v = vec.get(text);
    if (!v) {
      const ref = m.vectors[textHash(text)];
      if (!ref) throw new Error(`no vector for "${text.slice(0, 40)}" — the fixture has a hole`);
      v = Array.from(readVec(blob, ref));
      vec.set(text, v);
    }
    return v;
  };

  const perPair: Decision[] = population(m)
    .map((p) => {
      const sim = roundSim(cosine(vecOf(p.textA), vecOf(p.textB)));
      const ab = orient(p.textA, p.textB, sim, tau, guardEnabled);
      const ba = orient(p.textB, p.textA, sim, tau, guardEnabled);
      return {
        key: pairKey(p.textA, p.textB),
        textA: p.textA,
        textB: p.textB,
        truth: p.truth,
        source: p.source,
        sim,
        ab,
        ba,
        served: (ab.hit && ab.guard) || (ba.hit && ba.guard),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const bySource: Record<PairSource, number> = { generated: 0, traffic: 0, probe: 0, quarantined: 0 };
  for (const d of perPair) bySource[d.source]++;
  const aggregates: Aggregates = {
    pairs: perPair.length,
    bySource,
    falseAccepts: perPair.filter((d) => d.truth === "different" && d.served).length,
    trueAccepts: perPair.filter((d) => d.truth === "same" && d.served).length,
    guardSaves: perPair.filter((d) => d.truth === "different" && !d.served && (d.ab.hit || d.ba.hit)).length,
  };
  return { fixtureHash: m.fixtureHash, keyModel: m.keyModel, keyModelSource: m.keyModelSource, tau: m.tau, guardEnabled, aggregates, perPair };
}

// --- the verdict --------------------------------------------------------------

export type BaselinePair = Pick<Decision, "key" | "truth" | "source" | "sim" | "served" | "ab" | "ba">;

export type Baseline = {
  fixtureHash: string;
  gitSha: string;
  scoredAt: string;
  keyModel: string;
  keyModelSource: Manifest["keyModelSource"];
  tau: Manifest["tau"];
  guardEnabled: boolean;
  aggregates: Aggregates;
  perPair: BaselinePair[];
};

export type Mover = {
  key: string;
  textA: string;
  textB: string;
  truth: PairLabel;
  source: PairSource;
  sim: number;
  simBefore: number;
  before: { served: boolean; ab: Orientation; ba: Orientation };
  after: { served: boolean; ab: Orientation; ba: Orientation };
  // What the move means for the gate.
  kind: "new-false-accept" | "lost-true-accept" | "fixed-false-accept" | "new-true-accept" | "orientation-only";
};

export type Verdict = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  notices: string[];
  movers: Mover[];
  maxSimDrift: number;
};

const sameOrientation = (a: Orientation, b: Orientation) => a.hit === b.hit && a.guard === b.guard;

export function compare(baseline: Baseline, run: Run, opts: { strict: boolean }): Verdict {
  if (baseline.fixtureHash !== run.fixtureHash) {
    throw new Error(
      `baseline is for a different fixture (${baseline.fixtureHash.slice(0, 16)}… vs ${run.fixtureHash.slice(0, 16)}…) — ` +
        "run `npm run cache:gate -- baseline` and commit it",
    );
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const movers: Mover[] = [];
  let maxSimDrift = 0;

  // A fixture exported under a code default is only right while that default
  // stays put; the export recorded which dial τ and the key model came from.
  // The key model matters more than τ: under another model the frozen vectors
  // are the wrong experiment entirely, and "0 pairs moved" would be a lie.
  if (run.tau.source === "default" && config.semanticCache.defaultThreshold !== run.tau.value) {
    errors.push(
      `config.semanticCache.defaultThreshold is ${config.semanticCache.defaultThreshold} but the fixture was exported at ${run.tau.value} (source: default) — re-export, or set the config's own threshold`,
    );
  }
  if (run.keyModelSource === "default" && config.semanticCache.keyModel !== run.keyModel) {
    errors.push(
      `config.semanticCache.keyModel is ${config.semanticCache.keyModel} but the fixture's vectors are ${run.keyModel} (source: default) — re-export under the new model, or set the config's own key model`,
    );
  }
  if (baseline.guardEnabled !== run.guardEnabled) {
    (opts.strict ? errors : warnings).push(`entity guard is ${run.guardEnabled ? "ON" : "OFF"}; the baseline was taken with it ${baseline.guardEnabled ? "ON" : "OFF"}`);
  }

  const before = new Map(baseline.perPair.map((p) => [p.key, p]));
  for (const d of run.perPair) {
    const b = before.get(d.key);
    if (!b) {
      errors.push(`pair not in baseline: "${d.textA.slice(0, 50)}" / "${d.textB.slice(0, 50)}"`);
      continue;
    }
    maxSimDrift = Math.max(maxSimDrift, Math.abs(d.sim - b.sim));
    if (b.served === d.served && sameOrientation(b.ab, d.ab) && sameOrientation(b.ba, d.ba)) continue;
    const kind: Mover["kind"] =
      b.served === d.served
        ? "orientation-only"
        : d.served
          ? d.truth === "different"
            ? "new-false-accept"
            : "new-true-accept"
          : d.truth === "different"
            ? "fixed-false-accept"
            : "lost-true-accept";
    movers.push({
      key: d.key,
      textA: d.textA,
      textB: d.textB,
      truth: d.truth,
      source: d.source,
      sim: d.sim,
      simBefore: b.sim,
      before: { served: b.served, ab: b.ab, ba: b.ba },
      after: { served: d.served, ab: d.ab, ba: d.ba },
      kind,
    });
  }
  if (run.perPair.length !== baseline.perPair.length) {
    errors.push(`baseline has ${baseline.perPair.length} pairs, this run ${run.perPair.length}`);
  }

  const byKind = (k: Mover["kind"]) => movers.filter((m) => m.kind === k);
  const describe = (m: Mover) => `"${m.textA.slice(0, 60)}" ↔ "${m.textB.slice(0, 60)}" (sim ${m.sim.toFixed(4)}, ${m.source})`;

  if (opts.strict) {
    // main's code must reproduce main's baseline EXACTLY.
    if (movers.length > 0) errors.push(`baseline stale — ${movers.length} pair(s) decide differently from baseline.json; refresh it with \`npm run cache:gate -- baseline\``);
    if (maxSimDrift > SIM_DRIFT_TOLERANCE) errors.push(`baseline stale — a cosine moved by ${maxSimDrift.toExponential(2)}`);
  } else {
    // THE GATE. One new false accept is one confidently wrong answer served
    // without the LLM; there is no margin on that.
    for (const m of byKind("new-false-accept")) errors.push(`NEW FALSE ACCEPT: ${describe(m)}`);
    for (const m of byKind("lost-true-accept")) warnings.push(`lost true accept (cache cost, not quality): ${describe(m)}`);
    const fixed = byKind("fixed-false-accept");
    const gained = byKind("new-true-accept");
    if (fixed.length > 0 || gained.length > 0) {
      notices.push(
        `cache decisions improved (${fixed.length} false accept(s) no longer served, ${gained.length} true accept(s) gained) — ` +
          "refresh the baseline in this PR with `npm run cache:gate -- baseline`, or main's baseline will understate main",
      );
    }
    const orientation = byKind("orientation-only");
    if (orientation.length > 0) notices.push(`${orientation.length} pair(s) changed in one orientation only, with the same outcome — refresh the baseline if intended`);
    if (maxSimDrift > SIM_DRIFT_TOLERANCE) notices.push(`cosines moved by up to ${maxSimDrift.toExponential(2)} — did you mean to change the similarity?`);
  }

  return { ok: errors.length === 0, errors, warnings, notices, movers, maxSimDrift };
}

export function annotations(v: Verdict): string[] {
  return [
    ...v.errors.map((m) => `::error title=cache gate::${m}`),
    ...v.warnings.map((m) => `::warning title=cache gate::${m}`),
    ...v.notices.map((m) => `::notice title=cache gate::${m}`),
  ];
}

const o = (x: Orientation) => `${x.hit ? "hit" : "miss"}${x.hit && !x.guard ? "+guard" : ""}`;

export function summaryMarkdown(baseline: Baseline, run: Run, v: Verdict, opts: { strict: boolean }): string {
  const a = run.aggregates;
  const b = baseline.aggregates;
  const row = (name: string, x: number, y: number) => `| ${name} | ${x} | ${y} | ${y - x > 0 ? "+" : ""}${y - x} |`;
  const lines = [
    `## cache gate — ${v.ok ? "✅ pass" : "❌ fail"}${opts.strict ? " (strict: main must reproduce its baseline)" : ""}`,
    "",
    `The semantic cache's match decision over frozen pairs (fixture \`${run.fixtureHash.slice(0, 16)}…\`, baseline from \`${baseline.gitSha.slice(0, 10)}\`): ` +
      `key model ${run.keyModel}, τ ${run.tau.value} (${run.tau.source}), entity guard ${run.guardEnabled ? "on" : "off"}, ${a.pairs} pairs ` +
      `(${a.bySource.generated} generated, ${a.bySource.probe} probe, ${a.bySource.traffic} traffic, ${a.bySource.quarantined} quarantined-relabelled). ` +
      "Any new false accept fails; a lost true accept warns.",
    "",
    "| | baseline | this run | delta |",
    "|---|---|---|---|",
    row("false accepts (different, served)", b.falseAccepts, a.falseAccepts),
    row("true accepts (same, served)", b.trueAccepts, a.trueAccepts),
    row("guard saves", b.guardSaves, a.guardSaves),
    "",
  ];
  for (const m of [...v.errors, ...v.warnings, ...v.notices]) lines.push(`- ${m}`);
  if (v.movers.length > 0) {
    lines.push("", `### ${v.movers.length} pair(s) decided differently`, "", "| kind | truth | source | sim | question ↔ banked | before (ab / ba) | after (ab / ba) |", "|---|---|---|---|---|---|---|");
    for (const m of v.movers) {
      const esc = (t: string) => t.replace(/\|/g, "\\|").slice(0, 70);
      lines.push(
        `| ${m.kind} | ${m.truth} | ${m.source} | ${m.sim.toFixed(4)} | ${esc(m.textA)} ↔ ${esc(m.textB)} | ${o(m.before.ab)} / ${o(m.before.ba)} | ${o(m.after.ab)} / ${o(m.after.ba)} |`,
      );
    }
  } else {
    lines.push("No pair decided differently.");
  }
  return lines.join("\n") + "\n";
}
