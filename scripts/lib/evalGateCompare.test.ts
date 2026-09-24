import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { annotations, compare, summaryMarkdown, type Baseline, type QuestionRank, type Run, type Statements } from "./evalGateCompare";

const HASH = "f".repeat(64);
const K = 5;

// Four questions, two on the same chunk (a real property of the fixture: 118
// questions on 106 chunks), one miss in the baseline.
function ranks(overrides: Partial<Record<string, number | null>> = {}): QuestionRank[] {
  const base: QuestionRank[] = [
    { key: "a.md#0", question: "what is a", rank: 1 },
    { key: "a.md#0", question: "why is a", rank: 2 },
    { key: "b.md#3", question: "what is b", rank: 1 },
    { key: "c.md#1", question: "what is c", rank: null },
  ];
  return base.map((q) => (q.question in overrides ? { ...q, rank: overrides[q.question] ?? null } : q));
}

function aggregates(qs: QuestionRank[]) {
  const hits = qs.filter((q) => q.rank !== null && q.rank <= K).length;
  const mrr = qs.reduce((s, q) => s + (q.rank === null || q.rank > K ? 0 : 1 / q.rank), 0) / qs.length;
  return { questions: qs.length, hits, recall: hits / qs.length, mrr, ndcg: mrr };
}

const STMTS: Statements = { total: 1000, byPrefix: { "select chunks": 600, "select embedding_cache": 300, begin: 100 } };

// null = a baseline written before the statement budget existed.
function baseline(qs = ranks(), statements: Statements | null = STMTS): Baseline {
  return { fixtureHash: HASH, gitSha: "abc1234", scoredAt: "2026-09-23T00:00:00.000Z", k: K, ...aggregates(qs), perQuestion: qs, statements: statements ?? undefined };
}

function run(qs = ranks(), fixtureHash = HASH, statements: Statements = STMTS): Run {
  return { fixtureHash, k: K, aggregates: aggregates(qs), perQuestion: qs, statements };
}

const loose = { margin: 0.005, strict: false };
const strict = { margin: 0, strict: true };

describe("compare", () => {
  it("passes an identical run with nothing to say", () => {
    const v = compare(baseline(), run(), loose);
    assert.equal(v.ok, true);
    assert.deepEqual([v.errors, v.warnings, v.notices, v.movers], [[], [], [], []]);
    assert.deepEqual(annotations(v), []);
  });

  it("refuses a baseline for a different fixture", () => {
    assert.throws(() => compare(baseline(), run(ranks(), "0".repeat(64)), loose), /different fixture/);
  });

  it("fails when Recall@k drops past the margin, naming the question", () => {
    const v = compare(baseline(), run(ranks({ "what is b": 7 })), loose);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /Recall@5 regressed: 75\.00% → 50\.00%/);
    assert.deepEqual(v.movers, [{ key: "b.md#3", question: "what is b", before: 1, after: 7 }]);
    // The reciprocal-rank drop is warn-only.
    assert.match(v.warnings[0], /MRR@5 dropped/);
    assert.match(annotations(v)[0], /^::error title=eval gate::/);
  });

  it("a rank drop inside the top k warns but does not fail", () => {
    const v = compare(baseline(), run(ranks({ "what is a": 3 })), loose);
    assert.equal(v.ok, true);
    assert.equal(v.errors.length, 0);
    assert.equal(v.warnings.length, 2, "MRR and nDCG both warn");
    assert.equal(v.movers.length, 1);
  });

  it("an improvement passes and asks for a baseline refresh", () => {
    const v = compare(baseline(), run(ranks({ "what is c": 2 })), loose);
    assert.equal(v.ok, true);
    assert.match(v.notices[0], /improved \(recall, mrr, ndcg\).*refresh the baseline/);
  });

  it("a wide margin absorbs one lost question", () => {
    const v = compare(baseline(), run(ranks({ "what is b": null })), { margin: 0.3, strict: false });
    assert.equal(v.ok, true);
  });

  it("two questions on one chunk are told apart", () => {
    const v = compare(baseline(), run(ranks({ "why is a": 4 })), loose);
    assert.deepEqual(v.movers.map((m) => m.question), ["why is a"]);
  });

  it("strict fails on any moved rank, in either direction", () => {
    const worse = compare(baseline(), run(ranks({ "what is a": 2 })), strict);
    assert.equal(worse.ok, false);
    assert.match(worse.errors[0], /baseline stale/);
    const better = compare(baseline(), run(ranks({ "what is c": 1 })), strict);
    assert.equal(better.ok, false);
    assert.match(better.errors[0], /baseline stale/);
    assert.equal(compare(baseline(), run(), strict).ok, true);
  });

  it("a question the baseline never saw is an error", () => {
    const extra = [...ranks(), { key: "d.md#0", question: "what is d", rank: 1 }];
    const v = compare(baseline(), run(extra), loose);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /not in baseline: d\.md#0/);
    assert.match(v.errors[1], /baseline has 4 questions, this run 5/);
  });
});

describe("compare — statement budget", () => {
  const grown: Statements = { total: 1100, byPrefix: { "select chunks": 650, "select embedding_cache": 350, begin: 100 } };

  it("fails past the margin and names the prefixes that grew, largest first", () => {
    const v = compare(baseline(), run(ranks(), HASH, grown), loose);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /statement budget exceeded: 1000 → 1100 \(\+10\.0%\).*grew: select chunks 600→650, select embedding_cache 300→350/);
    assert.deepEqual(
      v.statementMovers.map((m) => m.prefix),
      ["select chunks", "select embedding_cache"],
    );
  });

  it("growth inside the margin passes", () => {
    const small: Statements = { total: 1015, byPrefix: { ...STMTS.byPrefix, "select chunks": 615 } };
    assert.equal(compare(baseline(), run(ranks(), HASH, small), loose).ok, true);
    assert.equal(compare(baseline(), run(ranks(), HASH, grown), { ...loose, stmtMargin: 0.2 }).ok, true);
  });

  it("a drop passes and asks for a refresh", () => {
    const fewer: Statements = { total: 900, byPrefix: { ...STMTS.byPrefix, begin: 0 } };
    const v = compare(baseline(), run(ranks(), HASH, fewer), loose);
    assert.equal(v.ok, true);
    assert.match(v.notices[0], /statements fell 1000 → 900/);
  });

  it("strict demands the exact count, in either direction", () => {
    const fewer: Statements = { total: 999, byPrefix: { ...STMTS.byPrefix, begin: 99 } };
    assert.match(compare(baseline(), run(ranks(), HASH, fewer), strict).errors[0], /baseline stale — scoring issued 999 statements/);
    assert.equal(compare(baseline(), run(), strict).ok, true);
  });

  it("a baseline without a count warns instead of guessing", () => {
    const v = compare(baseline(ranks(), null), run(), loose);
    assert.equal(v.ok, true);
    assert.match(v.warnings[0], /no statement count/);
  });
});

describe("summaryMarkdown", () => {
  it("carries the numbers, the margin and the movers table", () => {
    const b = baseline();
    const r = run(ranks({ "what is b": 7 }));
    const md = summaryMarkdown(b, r, compare(b, r, loose), loose);
    assert.match(md, /❌ fail/);
    assert.match(md, /\| Recall@5 \| 75\.00% \| 50\.00% \| -25\.00% \|/);
    assert.match(md, /Margin 0\.50%/);
    assert.match(md, /\| `b\.md#3` \| what is b \| 1 \| 7 \|/);
    assert.match(md, /\| statements \| 1000 \| 1000 \| 0 \|/);
  });

  it("tables the statement prefixes that changed", () => {
    const b = baseline();
    const r = run(ranks(), HASH, { total: 1100, byPrefix: { ...STMTS.byPrefix, "select chunks": 700 } });
    const md = summaryMarkdown(b, r, compare(b, r, loose), loose);
    assert.match(md, /\| `select chunks` \| 600 \| 700 \| \+100 \|/);
  });

  it("says so when nothing moved", () => {
    const b = baseline();
    const md = summaryMarkdown(b, run(), compare(b, run(), loose), loose);
    assert.match(md, /✅ pass/);
    assert.match(md, /No question changed rank/);
  });
});
