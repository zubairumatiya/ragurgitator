// STATEMENT METER (docs/obs-4-ci-budgets-plan.md §1.1). A client-side count of
// every statement postgres.js writes, fed by lib/db.ts's `debug` hook when
// RAG_STATEMENT_METER=1. Client-side rather than pg_stat_statements because a
// CI budget has to be deterministic: pg_stat_statements needs a preloaded
// library on the service container and would count the harness's own queries.
//
// Records the statement's shape (keyword + first table), never its parameters.
//
// No imports on purpose, for the reason lib/autotuneTiming.ts gives: lib/db.ts
// imports this, so this must not import lib/db.ts.
export const STATEMENT_METER = process.env.RAG_STATEMENT_METER === "1";

export type StatementSnapshot = { total: number; byPrefix: Record<string, number> };

type Meter = { total: number; byPrefix: Map<string, number> };

// On globalThis because the pool is: lib/db.ts caches its pools there in dev, so
// the hook closes over the first bundle graph's copy of this module.
declare global {
  var __ragStatementMeter: Meter | undefined;
}
const meter = (globalThis.__ragStatementMeter ??= { total: 0, byPrefix: new Map() });

const TABLE = /\b(?:from|into|update)\s+("[^"]+"|[a-z_][\w.$]*)/;

// `select chunks_voyage_4_1024`, `insert eval_results`, `begin`. The first
// keyword alone would say "select grew"; the table says which select.
export function statementPrefix(query: string): string {
  const q = query.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const keyword = q.match(/^[a-z_]+/)?.[0] ?? "?";
  const table = q.match(TABLE)?.[1]?.replace(/"/g, "");
  return table ? `${keyword} ${table}` : keyword;
}

export function recordStatement(query: unknown): void {
  meter.total += 1;
  const prefix = typeof query === "string" ? statementPrefix(query) : "?";
  meter.byPrefix.set(prefix, (meter.byPrefix.get(prefix) ?? 0) + 1);
}

export const statementMeter = {
  reset(): void {
    meter.total = 0;
    meter.byPrefix.clear();
  },
  // Prefixes sorted by count, then name, so a snapshot serializes to the same
  // bytes on every run that issued the same statements.
  snapshot(): StatementSnapshot {
    const entries = [...meter.byPrefix].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { total: meter.total, byPrefix: Object.fromEntries(entries) };
  },
};
