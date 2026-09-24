// The eval gate's verdict (docs/ci-eval-gate-plan.md §3): a scoring run against
// the committed baseline. Pure — the run and the baseline come in as data, the
// verdict goes out as data, and the GitHub annotations are rendered from it.
// Kept apart from eval-gate-run.ts so the rule can be unit-tested without a
// database.

export type QuestionRank = { key: string; question: string; rank: number | null };

export type Aggregates = { recall: number; mrr: number; ndcg: number; questions: number; hits: number };

// lib/observability/statementMeter's snapshot over the scoring run
// (docs/obs-4-ci-budgets-plan.md §1.1).
export type Statements = { total: number; byPrefix: Record<string, number> };

export type Baseline = {
  fixtureHash: string;
  gitSha: string;
  scoredAt: string;
  k: number;
  recall: number;
  mrr: number;
  ndcg: number;
  questions: number;
  hits: number;
  perQuestion: QuestionRank[];
  // Absent in a baseline written before the statement budget existed; the gate
  // then says it cannot check the budget rather than inventing one.
  statements?: Statements;
};

export type Run = { fixtureHash: string; k: number; aggregates: Aggregates; perQuestion: QuestionRank[]; statements: Statements };

export type PrefixMover = { prefix: string; before: number; after: number };

export type Mover = { key: string; question: string; before: number | null; after: number | null };

export type Verdict = {
  ok: boolean;
  // ::error:: lines — any one of these is the red build.
  errors: string[];
  // ::warning:: — MRR / nDCG drops, warn-only in the first cut (decision 4).
  warnings: string[];
  // ::notice:: — an improvement, and the ask to refresh the baseline with it.
  notices: string[];
  movers: Mover[];
  // Statement prefixes whose count changed, largest growth first; the top five
  // are what a statement-budget failure names.
  statementMovers: PrefixMover[];
  delta: { recall: number; mrr: number; ndcg: number };
};

// Sums of 118 reciprocals are not bit-stable across Node versions; deltas below
// this are formatting, not retrieval.
const EPS = 1e-9;

export const DEFAULT_MARGIN = 0.005;

// Statements over baseline by more than this fraction is red. The count is
// deterministic over the fixture, so the margin is room for an intended small
// change, not for noise.
export const DEFAULT_STMT_MARGIN = 0.02;

function prefixMovers(before: Record<string, number>, after: Record<string, number>): PrefixMover[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: PrefixMover[] = [];
  for (const prefix of names) {
    const b = before[prefix] ?? 0;
    const a = after[prefix] ?? 0;
    if (a !== b) out.push({ prefix, before: b, after: a });
  }
  return out.sort((x, y) => y.after - y.before - (x.after - x.before) || (x.prefix < y.prefix ? -1 : 1));
}

const topGrown = (ms: PrefixMover[]): string =>
  ms
    .filter((m) => m.after > m.before)
    .slice(0, 5)
    .map((m) => `${m.prefix} ${m.before}→${m.after}`)
    .join(", ");

// A question is identified by its source chunk AND its text: 118 questions sit
// on 106 chunks.
const qid = (q: { key: string; question: string }): string => `${q.key}\u0000${q.question}`;

export type CompareOpts = { margin: number; strict: boolean; stmtMargin?: number };

export function compare(baseline: Baseline, run: Run, opts: CompareOpts): Verdict {
  if (baseline.fixtureHash !== run.fixtureHash) {
    throw new Error(
      `baseline is for a different fixture (${baseline.fixtureHash.slice(0, 16)}… vs ${run.fixtureHash.slice(0, 16)}…) — ` +
        "run `npm run eval:gate -- baseline` and commit it",
    );
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const a = run.aggregates;
  const delta = { recall: a.recall - baseline.recall, mrr: a.mrr - baseline.mrr, ndcg: a.ndcg - baseline.ndcg };

  const before = new Map(baseline.perQuestion.map((q) => [qid(q), q]));
  const movers: Mover[] = [];
  for (const q of run.perQuestion) {
    const b = before.get(qid(q));
    if (!b) {
      errors.push(`question not in baseline: ${q.key} "${q.question.slice(0, 60)}"`);
      continue;
    }
    if (b.rank !== q.rank) movers.push({ key: q.key, question: q.question, before: b.rank, after: q.rank });
  }
  if (run.perQuestion.length !== baseline.perQuestion.length) {
    errors.push(`baseline has ${baseline.perQuestion.length} questions, this run ${run.perQuestion.length}`);
  }

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const k = run.k;
  if (opts.strict) {
    // main's code must reproduce main's baseline EXACTLY: any moved rank means
    // the committed numbers no longer describe the committed code.
    if (movers.length > 0) {
      errors.push(`baseline stale — ${movers.length} question(s) rank differently from baseline.json; refresh it with \`npm run eval:gate -- baseline\``);
    }
    for (const [name, d] of Object.entries(delta)) {
      if (Math.abs(d) > EPS) errors.push(`baseline stale — ${name} moved by ${d >= 0 ? "+" : ""}${d.toFixed(4)}`);
    }
  } else {
    if (baseline.recall - a.recall > opts.margin + EPS) {
      errors.push(
        `Recall@${k} regressed: ${pct(baseline.recall)} → ${pct(a.recall)} (${a.hits}/${a.questions} vs ${baseline.hits}/${baseline.questions}), ` +
          `more than the ${pct(opts.margin)} margin`,
      );
    }
    if (baseline.mrr - a.mrr > EPS) warnings.push(`MRR@${k} dropped: ${baseline.mrr.toFixed(4)} → ${a.mrr.toFixed(4)} (warn-only)`);
    if (baseline.ndcg - a.ndcg > EPS) warnings.push(`nDCG@${k} dropped: ${baseline.ndcg.toFixed(4)} → ${a.ndcg.toFixed(4)} (warn-only)`);
    const improved = (["recall", "mrr", "ndcg"] as const).filter((m) => delta[m] > EPS);
    if (improved.length > 0) {
      notices.push(
        `retrieval improved (${improved.join(", ")}) — refresh the baseline in this PR with \`npm run eval:gate -- baseline\`, ` +
          "or main's baseline will understate main",
      );
    } else if (movers.length > 0 && errors.length === 0 && warnings.length === 0) {
      notices.push(`${movers.length} question(s) changed rank with no aggregate change — refresh the baseline if the change is intended`);
    }
  }

  const bs = baseline.statements;
  const rs = run.statements;
  const statementMovers = bs ? prefixMovers(bs.byPrefix, rs.byPrefix) : [];
  if (!bs) {
    warnings.push("baseline.json has no statement count — the statement budget is unchecked until `npm run eval:gate -- baseline` refreshes it");
  } else if (opts.strict) {
    if (rs.total !== bs.total) {
      errors.push(`baseline stale — scoring issued ${rs.total} statements, baseline.json says ${bs.total}; refresh it with \`npm run eval:gate -- baseline\``);
    }
  } else {
    const stmtMargin = opts.stmtMargin ?? DEFAULT_STMT_MARGIN;
    if (rs.total > bs.total * (1 + stmtMargin)) {
      errors.push(
        `statement budget exceeded: ${bs.total} → ${rs.total} (+${(((rs.total - bs.total) / bs.total) * 100).toFixed(1)}%), ` +
          `more than the ${pct(stmtMargin)} margin; grew: ${topGrown(statementMovers)}`,
      );
    } else if (rs.total < bs.total) {
      notices.push(`statements fell ${bs.total} → ${rs.total} — refresh the baseline in this PR so main's budget keeps the win`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, notices, movers, statementMovers, delta };
}

// GitHub workflow commands: one line each on stdout, which the runner turns into
// annotations on the PR.
export function annotations(v: Verdict): string[] {
  return [
    ...v.errors.map((m) => `::error title=eval gate::${m}`),
    ...v.warnings.map((m) => `::warning title=eval gate::${m}`),
    ...v.notices.map((m) => `::notice title=eval gate::${m}`),
  ];
}

const fmt = (x: number, digits: number, pct = false) => (pct ? `${(x * 100).toFixed(digits)}%` : x.toFixed(digits));
const signed = (x: number, digits: number, pct = false) => `${x > 0 ? "+" : ""}${fmt(x, digits, pct)}`;

// Markdown for $GITHUB_STEP_SUMMARY: the three numbers before/after, the margin,
// and WHICH questions moved from what rank to what.
export function summaryMarkdown(baseline: Baseline, run: Run, v: Verdict, opts: CompareOpts): string {
  const a = run.aggregates;
  const k = run.k;
  const row = (name: string, b: number, n: number, d: number, pct: boolean) =>
    `| ${name} | ${fmt(b, pct ? 2 : 4, pct)} | ${fmt(n, pct ? 2 : 4, pct)} | ${signed(d, pct ? 2 : 4, pct)} |`;
  const lines = [
    `## eval gate — ${v.ok ? "✅ pass" : "❌ fail"}${opts.strict ? " (strict: main must reproduce its baseline)" : ""}`,
    "",
    `Regression gate over frozen data (fixture \`${run.fixtureHash.slice(0, 16)}…\`, baseline from \`${baseline.gitSha.slice(0, 10)}\`), ` +
      `exact scan, ${run.perQuestion.length} questions. Margin ${fmt(opts.margin, 2, true)} on Recall@${k}; MRR and nDCG warn only.`,
    "",
    "| metric | baseline | this run | delta |",
    "|---|---|---|---|",
    row(`Recall@${k}`, baseline.recall, a.recall, v.delta.recall, true),
    row(`MRR@${k}`, baseline.mrr, a.mrr, v.delta.mrr, false),
    row(`nDCG@${k}`, baseline.ndcg, a.ndcg, v.delta.ndcg, false),
    `| statements | ${baseline.statements?.total ?? "—"} | ${run.statements.total} | ${
      baseline.statements ? signed(run.statements.total - baseline.statements.total, 0) : "—"
    } |`,
    "",
  ];
  for (const m of [...v.errors, ...v.warnings, ...v.notices]) lines.push(`- ${m}`);
  if (v.movers.length > 0) {
    lines.push("", `### ${v.movers.length} question(s) moved`, "", "| chunk | question | rank before | rank after |", "|---|---|---|---|");
    for (const m of v.movers) {
      const q = m.question.replace(/\|/g, "\\|").slice(0, 80);
      lines.push(`| \`${m.key}\` | ${q} | ${m.before ?? "—"} | ${m.after ?? "—"} |`);
    }
  } else {
    lines.push("No question changed rank.");
  }
  if (v.statementMovers.length > 0) {
    lines.push("", `### ${v.statementMovers.length} statement prefix(es) changed count`, "", "| prefix | before | after | delta |", "|---|---|---|---|");
    for (const m of v.statementMovers.slice(0, 10)) {
      lines.push(`| \`${m.prefix}\` | ${m.before} | ${m.after} | ${signed(m.after - m.before, 0)} |`);
    }
  }
  return lines.join("\n") + "\n";
}
