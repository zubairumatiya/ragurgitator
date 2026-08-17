// Shared scaffolding for the resume-metrics follow-up drivers (f1, f2, f3).
//
// f2 was built by forking f1 wholesale, and f3 is the third fork — so the parts
// all three need identically live here instead of being copied a third time:
// owner lookup + scope entry, the constructed-label → verdict mapping, the
// adjudication template/load/gate trio, and the confusion-matrix printer.
//
// f1 and f2 are deliberately NOT refactored onto this. They are finished runs
// whose outputs are published in docs/; rewriting them now would risk changing a
// number that a write-up already quotes, for no gain. New drivers import this.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import type { Sql } from "postgres";

import { withUser } from "../../lib/auth/userScope";
import { resolveConfig, withConfig } from "../../lib/rag/activeConfig";

// The config every follow-up has run against. Overridable so a second account
// can re-run any of this without editing the source.
export const CONFIG_ID = process.env.SCRIPT_CONFIG_ID ?? "45b73063-403e-4a44-8d6e-b9eacf7e316a";

export type Owner = { id: string; email: string };

// A driver runs outside a request, so nothing has populated the user/config
// AsyncLocalStorage that every lib/rag function reads. This resolves the owner
// from the config row itself rather than taking it on the command line — the two
// can't then disagree, and an unowned config fails loudly here instead of
// producing an empty result set later.
export async function loadOwner(sql: Sql): Promise<Owner> {
  const [row] = await sql<{ user_id: string; email: string }[]>`
    select c.user_id, u.email from configs c join auth.users u on u.id = c.user_id
    where c.id = ${CONFIG_ID}`;
  if (!row) throw new Error(`config ${CONFIG_ID} not found`);
  return { id: row.user_id, email: row.email };
}

// Run `fn` with the same user + config scope a request would have. Both are
// needed: RLS reads the user, and the cache/eval code reads the active config.
export function inScope<T>(owner: Owner, fn: () => Promise<T>): Promise<T> {
  return withUser(owner, async () => {
    const cfg = await resolveConfig(CONFIG_ID);
    if (!cfg) throw new Error("config not found in user scope");
    return withConfig(cfg, fn);
  });
}

export type ConstructedLabel = "same" | "different";
export type Verdict = "accept" | "reject";

// What a constructed label predicts a judge will say. 'same' means one answer
// serves both, which is exactly an accept.
export const expected = (label: ConstructedLabel): Verdict =>
  label === "same" ? "accept" : "reject";

// --- adjudication ------------------------------------------------------------
//
// F1 settled that NEITHER side of a disagreement is authoritative: of its 12
// judge-vs-construction disputes the generator was wrong 8 times and the judge 4.
// So a disagreement is not resolved by picking a side in code — it is resolved by
// a human, and every driver enforces that with the same three pieces.

// A hand-filled row. `label` starts null and the run is blocked until it isn't;
// `_`-prefixed fields in the written file are read-only context for the human.
export type Adjudication = { key: string; label: ConstructedLabel | null; why: string };

// Only rows with a label count as adjudicated — an entry left null is the same as
// no entry, so re-running `adjudicate` never loses work in progress.
export function loadAdjudications(path: string): Map<string, Adjudication> {
  if (!existsSync(path)) return new Map();
  const rows: Adjudication[] = JSON.parse(readFileSync(path, "utf8"));
  return new Map(rows.filter((r) => r.label).map((r) => [r.key, r]));
}

// Rewrite the template, preserving anything already filled in. `context` supplies
// the `_`-prefixed read-only fields for each row.
export function writeAdjudicationTemplate<T>(
  path: string,
  disputes: T[],
  key: (row: T) => string,
  context: (row: T) => Record<string, unknown>,
): number {
  const existing = loadAdjudications(path);
  const rows = disputes.map((d) => ({
    key: key(d),
    label: existing.get(key(d))?.label ?? null,
    why: existing.get(key(d))?.why ?? "",
    ...context(d),
  }));
  writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  return rows.filter((r) => r.label).length;
}

// The gate. Returns the unresolved keys; a caller with any must refuse to write
// truth. This is enforced rather than documented because skipping it is exactly
// how a generator's error rate gets laundered into ground truth.
export function unadjudicated(
  disputeKeys: string[],
  adjudications: Map<string, Adjudication>,
): string[] {
  return disputeKeys.filter((k) => !adjudications.has(k));
}

// --- reporting ---------------------------------------------------------------

export type MatrixRow = { label: ConstructedLabel; verdict: Verdict | null };

// judge-vs-construction, the headline number of every follow-up. Off-diagonal
// cells are the disputes; `agreement` is what the write-up quotes.
export function confusionMatrix(rows: MatrixRow[]): {
  judged: number;
  agree: number;
  agreement: number | null;
  cell: (label: ConstructedLabel, verdict: Verdict) => number;
} {
  const judged = rows.filter((r) => r.verdict !== null);
  const cell = (label: ConstructedLabel, verdict: Verdict) =>
    judged.filter((r) => r.label === label && r.verdict === verdict).length;
  const agree = judged.filter((r) => r.verdict === expected(r.label)).length;
  return {
    judged: judged.length,
    agree,
    agreement: judged.length > 0 ? agree / judged.length : null,
    cell,
  };
}

export function printMatrix(rows: MatrixRow[], title: string): void {
  const m = confusionMatrix(rows);
  console.log(`\n${title} — ${m.judged} judged`);
  if (m.judged === 0) {
    console.log("  nothing judged yet");
    return;
  }
  console.log("              judge:accept  judge:reject");
  console.log(
    `constructed same   ${String(m.cell("same", "accept")).padStart(8)}` +
      `${String(m.cell("same", "reject")).padStart(14)}`,
  );
  console.log(
    `constructed diff   ${String(m.cell("different", "accept")).padStart(8)}` +
      `${String(m.cell("different", "reject")).padStart(14)}`,
  );
  console.log(`agreement ${((m.agreement ?? 0) * 100).toFixed(1)}% (${m.agree}/${m.judged})`);
}
