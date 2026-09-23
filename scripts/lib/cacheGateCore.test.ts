import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { annotations, compare, decideAll, population, summaryMarkdown, type Baseline, type Run } from "./cacheGateCore";
import { VectorBlob, fixtureHash, textHash, type Manifest } from "./cacheGateFixture";

// Six texts in a 2-d space so the cosines are exact by inspection:
//   p ≈ q  (paraphrase, sim ≈ 0.995)
//   n1 vs n2: same tokens, reversed comparison → the order guard's case
//   x ⟂ y   (sim 0)
const P = "how many ships did Britain build in 1916";
const Q = "in 1916, how many ships did Britain build";
const N1 = "how many times larger was Japan's population compared to China's";
const N2 = "how many times larger was China's population compared to Japan's";
const X = "what is dark vision";
const Y = "who wrote the treaty";

function fixture(opts: { tau?: number; source?: Manifest["tau"]["source"] } = {}): { manifest: Manifest; blob: Buffer } {
  const blob = new VectorBlob();
  const v = (a: number, b: number) => blob.add(Float32Array.from([a, b]));
  const manifest: Manifest = {
    version: 1,
    exportedAt: "2026-09-23T00:00:00.000Z",
    sourceConfigId: "cfg",
    fixtureHash: "",
    keyModel: "voyage-4-lite",
    space: "voyage-4",
    dimension: 2,
    tau: { value: opts.tau ?? 0.95, source: opts.source ?? "config" },
    generated: [
      { textA: P, textB: Q, label: "same", difficulty: "paraphrase", verdict: null, verdictSource: null },
      // A hard negative a human said is really a paraphrase: quarantined, relabelled same.
      { textA: X, textB: Y, label: "different", difficulty: "hard-negative", verdict: "accept", verdictSource: "human" },
    ],
    shadow: [
      // A probe that duplicates a generated pair (even a quarantined one) is dropped.
      { textA: Y, textB: X, verdict: "reject", origin: "probe", simAtCapture: 0.5, guardBlockedAtCapture: false },
      // A reversed comparison at high cosine: the guard's job.
      { textA: N1, textB: N2, verdict: "reject", origin: "probe", simAtCapture: 0.99, guardBlockedAtCapture: false },
      { textA: P, textB: X, verdict: "reject", origin: "traffic", simAtCapture: 0.81, guardBlockedAtCapture: false },
    ],
    vectors: {
      [textHash(P)]: v(1, 0.1),
      [textHash(Q)]: v(1, 0.11),
      [textHash(N1)]: v(0.7, 0.7),
      [textHash(N2)]: v(0.7, 0.71),
      [textHash(X)]: v(0, 1),
      [textHash(Y)]: v(0.01, 1),
    },
  };
  const bytes = blob.toBuffer();
  manifest.fixtureHash = fixtureHash(manifest, bytes);
  return { manifest, blob: bytes };
}

const baselineOf = (run: Run): Baseline => ({
  fixtureHash: run.fixtureHash,
  gitSha: "abc1234",
  scoredAt: "2026-09-23T00:00:00.000Z",
  keyModel: run.keyModel,
  tau: run.tau,
  guardEnabled: run.guardEnabled,
  aggregates: run.aggregates,
  perPair: run.perPair.map(({ key, truth, source, sim, served, ab, ba }) => ({ key, truth, source, sim, served, ab, ba })),
});

const byText = (run: Run, a: string) => run.perPair.find((d) => d.textA === a || d.textB === a)!;

describe("population", () => {
  it("runs poolPairs (probe dupes dropped) and appends quarantined rows relabelled by verdict", () => {
    const { manifest } = fixture();
    const pop = population(manifest);
    assert.deepEqual(
      pop.map((p) => `${p.source}:${p.truth}`).sort(),
      ["generated:same", "probe:different", "quarantined:same", "traffic:different"],
    );
  });
});

describe("decideAll", () => {
  it("decides like the serving path: cosine ≥ τ, then the entity guard, in both orientations", () => {
    const { manifest, blob } = fixture();
    const run = decideAll(manifest, blob);
    const para = byText(run, P);
    assert.equal(para.truth, "same");
    assert.equal(para.served, true);
    assert.deepEqual(para.ab, { hit: true, guard: true });

    const reversed = byText(run, N1);
    assert.equal(reversed.truth, "different");
    assert.equal(reversed.ab.hit, true, "cosine alone would serve it");
    assert.equal(reversed.ab.guard, false, "the order guard vetoes it");
    assert.equal(reversed.served, false);

    assert.deepEqual(run.aggregates, {
      pairs: 4,
      bySource: { generated: 1, traffic: 1, probe: 1, quarantined: 1 },
      falseAccepts: 0,
      trueAccepts: 2,
      guardSaves: 1,
    });
  });

  it("is byte-stable and sorted by key", () => {
    const { manifest, blob } = fixture();
    assert.equal(JSON.stringify(decideAll(manifest, blob)), JSON.stringify(decideAll(manifest, blob)));
    const keys = decideAll(manifest, blob).perPair.map((d) => d.key);
    assert.deepEqual(keys, [...keys].sort());
  });
});

describe("compare", () => {
  it("passes an identical run silently", () => {
    const { manifest, blob } = fixture();
    const run = decideAll(manifest, blob);
    const v = compare(baselineOf(run), run, { strict: false });
    assert.equal(v.ok, true);
    assert.deepEqual([v.errors, v.warnings, v.notices, v.movers], [[], [], [], []]);
    assert.deepEqual(annotations(v), []);
    assert.equal(compare(baselineOf(run), run, { strict: true }).ok, true);
  });

  it("refuses a baseline for a different fixture", () => {
    const { manifest, blob } = fixture();
    const run = decideAll(manifest, blob);
    assert.throws(() => compare({ ...baselineOf(run), fixtureHash: "0".repeat(64) }, run, { strict: false }), /different fixture/);
  });

  it("a NEW false accept fails and names the pair", () => {
    const { manifest, blob } = fixture();
    const base = baselineOf(decideAll(manifest, blob));
    // Lowering τ lets the traffic reject (sim ≈ 0.1) in? No — use the guarded pair:
    // pretend the baseline had the reversed comparison blocked and this run serves it.
    const run = decideAll(manifest, blob);
    const rev = byText(run, N1);
    rev.ab = { hit: true, guard: true };
    rev.served = true;
    run.aggregates.falseAccepts = 1;
    const v = compare(base, run, { strict: false });
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /NEW FALSE ACCEPT: "how many times larger was Japan/);
    assert.equal(v.movers[0].kind, "new-false-accept");
    assert.match(annotations(v)[0], /^::error title=cache gate::NEW FALSE ACCEPT/);
  });

  it("a lost true accept only warns; an improvement passes with a refresh notice", () => {
    const { manifest, blob } = fixture();
    const run = decideAll(manifest, blob);
    // Baseline claims the paraphrase was served AND the reversed pair was served.
    const base = baselineOf(run);
    const bRev = base.perPair.find((p) => p.key === byText(run, N1).key)!;
    bRev.served = true;
    bRev.ab = { hit: true, guard: true };
    const lost = decideAll(manifest, blob);
    const para = byText(lost, P);
    para.served = false;
    para.ab = para.ba = { hit: false, guard: true };
    const v = compare(base, lost, { strict: false });
    assert.equal(v.ok, true);
    assert.match(v.warnings[0], /lost true accept/);
    assert.match(v.notices[0], /improved \(1 false accept\(s\) no longer served/);
    assert.deepEqual(v.movers.map((m) => m.kind).sort(), ["fixed-false-accept", "lost-true-accept"]);
  });

  it("strict fails on any change, including a cosine drift", () => {
    const { manifest, blob } = fixture();
    const run = decideAll(manifest, blob);
    const base = baselineOf(run);
    base.perPair[0].sim += 1e-4;
    const v = compare(base, run, { strict: true });
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /baseline stale — a cosine moved/);
    assert.equal(compare(base, run, { strict: false }).ok, true, "loose mode only notices drift");
    assert.match(compare(base, run, { strict: false }).notices[0], /cosines moved/);
  });

  it("a fixture exported at the code-default τ fails when that default moves", () => {
    const { manifest, blob } = fixture({ tau: 0.5, source: "default" });
    const run = decideAll(manifest, blob);
    const v = compare(baselineOf(run), run, { strict: false });
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /defaultThreshold is 0\.95 but the fixture was exported at 0\.5/);
  });

  it("summary carries the counts and the movers table", () => {
    const { manifest, blob } = fixture();
    const run = decideAll(manifest, blob);
    const md = summaryMarkdown(baselineOf(run), run, compare(baselineOf(run), run, { strict: false }), { strict: false });
    assert.match(md, /✅ pass/);
    assert.match(md, /\| false accepts \(different, served\) \| 0 \| 0 \| 0 \|/);
    assert.match(md, /No pair decided differently/);
  });
});

describe("import allow-list", () => {
  it("cacheGateCore reaches nothing that opens a database or a provider", () => {
    const src = readFileSync(join(__dirname, "cacheGateCore.ts"), "utf8");
    // Every `import` statement, including multi-line `import {\n …\n} from "x";`
    // (the house style) and side-effect `import "x";` — a single-line-only
    // match would let a wrapped db import through and the property would be
    // enforced in name only. The count is cross-checked against the raw
    // statement count so an unmatched form cannot slip past silently.
    const statements = src.match(/^import\b/gm)?.length ?? 0;
    const imports = [...src.matchAll(/^import\b[^"]*"([^"]+)";/gm)].map((m) => m[1]);
    assert.equal(imports.length, statements, "every import statement must be parsed");
    assert.ok(imports.length >= 4);
    const allowed = /^(\.\.\/\.\.\/lib\/config|\.\.\/\.\.\/lib\/rag\/semanticCacheCore|\.\.\/\.\.\/lib\/rag\/keyModelSweepCore|\.\/[A-Za-z]+)$/;
    for (const i of imports) assert.match(i, allowed, `import "${i}" is outside the allow-list`);
  });
});
