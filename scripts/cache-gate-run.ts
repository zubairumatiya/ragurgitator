// The pure half of the semantic cache gate: score, baseline, gate. Loaded by
// scripts/cache-gate.ts for anything but `export`, in the same process — there
// is no database to point at and nothing to refuse, so no preload and no child.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { annotations, compare, decideAll, summaryMarkdown, type Baseline, type Run } from "./lib/cacheGateCore";
import { fixtureHash, manifestProblems, type Manifest } from "./lib/cacheGateFixture";

const FIXTURE_DIR = "test/fixtures/cache-gate";
const BASELINE_FILE = join(FIXTURE_DIR, "baseline.json");

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

function readFixture(): { manifest: Manifest; blob: Buffer } {
  const manifest: Manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"));
  const blob = readFileSync(join(FIXTURE_DIR, "vectors.f32"));
  const problems = manifestProblems(manifest, blob.length / 4);
  if (problems.length > 0) throw new Error(`fixture has holes:\n  ${problems.slice(0, 10).join("\n  ")}`);
  const hash = fixtureHash(manifest, blob);
  if (hash !== manifest.fixtureHash) {
    throw new Error(`fixture hash mismatch: manifest says ${manifest.fixtureHash.slice(0, 16)}…, files hash to ${hash.slice(0, 16)}…`);
  }
  return { manifest, blob };
}

function score(): Run {
  const { manifest, blob } = readFixture();
  const run = decideAll(manifest, blob);
  const a = run.aggregates;
  console.log(`cache gate — the MATCH DECISION over frozen pairs · key model ${run.keyModel} · τ ${run.tau.value} (${run.tau.source}) · guard ${run.guardEnabled ? "on" : "off"} · 0 provider calls by construction`);
  console.log(`  fixture        ${run.fixtureHash.slice(0, 16)}… · ${a.pairs} pairs (${a.bySource.generated} generated, ${a.bySource.probe} probe, ${a.bySource.traffic} traffic, ${a.bySource.quarantined} quarantined-relabelled)`);
  console.log(`  false accepts  ${a.falseAccepts}   (different, served — the number to protect)`);
  console.log(`  true accepts   ${a.trueAccepts}   (same, served)`);
  console.log(`  guard saves    ${a.guardSaves}   (would have hit, guard vetoed, rightly)`);
  return run;
}

export async function run(command: "score" | "baseline" | "gate", args: string[]): Promise<void> {
  if (command === "score") {
    const out = flag(args, "out") ?? "cache-gate-results.json";
    const r = score();
    // No timestamp and no ids: byte-stable across runs of the same code.
    writeFileSync(out, JSON.stringify(r, null, 1) + "\n");
    console.log(`wrote ${out}`);
    return;
  }

  if (command === "baseline") {
    const r = score();
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const b: Baseline = {
      fixtureHash: r.fixtureHash,
      gitSha,
      scoredAt: new Date().toISOString(),
      keyModel: r.keyModel,
      keyModelSource: r.keyModelSource,
      tau: r.tau,
      guardEnabled: r.guardEnabled,
      aggregates: r.aggregates,
      perPair: r.perPair.map(({ key, truth, source, sim, served, ab, ba }) => ({ key, truth, source, sim, served, ab, ba })),
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 1) + "\n");
    console.log(`wrote ${BASELINE_FILE} at ${gitSha.slice(0, 10)} — commit it`);
    return;
  }

  const strict = args.includes("--strict");
  let baselineJson: string;
  try {
    baselineJson = readFileSync(BASELINE_FILE, "utf8");
  } catch {
    throw new Error(`${BASELINE_FILE} is missing — run \`npm run cache:gate -- baseline\` and commit it`);
  }
  const b: Baseline = JSON.parse(baselineJson);
  const r = score();
  const v = compare(b, r, { strict });

  const md = summaryMarkdown(b, r, v, { strict });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  else if (v.movers.length > 0) console.log("\n" + md.slice(md.indexOf("### ")));
  for (const line of annotations(v)) console.log(line);

  const d = (name: keyof Run["aggregates"] & ("falseAccepts" | "trueAccepts" | "guardSaves")) => {
    const x = r.aggregates[name] - b.aggregates[name];
    return `${x > 0 ? "+" : ""}${x}`;
  };
  console.log(
    `\ngate ${v.ok ? "PASS" : "FAIL"} — vs baseline ${b.gitSha.slice(0, 10)}: false accepts ${d("falseAccepts")} · true accepts ${d("trueAccepts")} · guard saves ${d("guardSaves")} · ` +
      (strict ? "strict (exact match required)" : "any new false accept fails") +
      ` · ${v.movers.length} pair(s) moved`,
  );
  if (!v.ok) process.exitCode = 1;
}
