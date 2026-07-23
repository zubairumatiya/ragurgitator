// ---------------------------------------------------------------------------
// DB layer for COST ACCOUNTING (migration 0034; docs/savings-accounting-plan.md).
//
// Two concerns, both raw SQL via the shared `sql` client:
//   1. WRITE — recordSaving / recordSpend: upsert a per-(config, lever|surface)
//      running total. Called fire-and-forget from the savings sites (embed cache,
//      cascade, semantic cache, batch apply, aggregate ranking) and the metered
//      LLM wrapper. saved_usd is SIGNED so the cascade nets escalations.
//   2. READ — getCostsReport: roll the two tables up account-wide and hand the
//      /appraise Costs section its itemized spreadsheet + the three view totals.
//
// Best-effort throughout, matching embedCache / semanticCache: a missing table
// (42P01, pre-migration) makes writes no-op and the read return an empty report,
// so the feature is safe to ship ahead of the migration and never breaks a hot
// path. Recording errors are swallowed (telemetry must not fail an answer).
// ---------------------------------------------------------------------------
import { sql } from "@/lib/db";
import { activeConfig } from "@/lib/rag/activeConfig";
import {
  LEVERS,
  SURFACE_LABELS,
  type LeverId,
  type SavingsBasis,
  type SavingsCategory,
  type Surface,
} from "@/lib/rag/pricing";

const isMissingTable = (err: unknown): boolean =>
  (err as { code?: string }).code === "42P01";

// activeConfig() throws outside a withConfig scope; a telemetry write must never
// be the thing that surfaces that. No scope (and no explicit id) → skip silently.
function scopeConfigId(): string | null {
  try {
    return activeConfig().id;
  } catch {
    return null;
  }
}

// Add to a lever's signed running total. `saved` may be negative (cascade
// escalation). configId defaults to the active scope; batch apply passes the
// job's config explicitly since it can run outside a request scope.
export async function recordSaving(
  lever: LeverId,
  saved: number,
  tokensSaved: number,
  opts: { events?: number; configId?: string | null } = {},
): Promise<void> {
  const configId = opts.configId ?? scopeConfigId();
  if (!configId) return;
  const events = opts.events ?? 1;
  try {
    await sql`
      insert into savings_totals (config_id, lever, event_count, tokens_saved, saved_usd, updated_at)
      values (${configId}, ${lever}, ${events}, ${Math.round(tokensSaved)}, ${saved}, now())
      on conflict (config_id, lever) do update set
        event_count  = savings_totals.event_count  + excluded.event_count,
        tokens_saved = savings_totals.tokens_saved + excluded.tokens_saved,
        saved_usd    = savings_totals.saved_usd    + excluded.saved_usd,
        updated_at   = now()
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    console.warn(`[rag:savings] record ${lever} failed: ${(err as Error).message}`);
  }
}

// Add to a surface's gross-spend total. Same best-effort contract as above.
export async function recordSpend(
  surface: Surface,
  spent: number,
  tokens: number,
  opts: { configId?: string | null } = {},
): Promise<void> {
  const configId = opts.configId ?? scopeConfigId();
  if (!configId) return;
  try {
    await sql`
      insert into spend_totals (config_id, surface, tokens, spent_usd, updated_at)
      values (${configId}, ${surface}, ${Math.round(tokens)}, ${spent}, now())
      on conflict (config_id, surface) do update set
        tokens     = spend_totals.tokens     + excluded.tokens,
        spent_usd  = spend_totals.spent_usd  + excluded.spent_usd,
        updated_at = now()
    `;
  } catch (err) {
    if (isMissingTable(err)) return;
    console.warn(`[rag:savings] spend ${surface} failed: ${(err as Error).message}`);
  }
}

// --- read side -------------------------------------------------------------

export type SavingsView = "realized" | "structural" | "naive";

export type LeverRow = {
  lever: LeverId;
  label: string;
  category: SavingsCategory;
  basis: SavingsBasis;
  events: number;
  tokensSaved: number;
  savedUsd: number;
};

export type SpendRow = {
  surface: Surface;
  label: string;
  tokens: number;
  spentUsd: number;
};

export type CostsReport = {
  levers: LeverRow[]; // itemized, most-saved first
  spend: SpendRow[]; // gross spend by surface, most-spent first
  totalSpentUsd: number;
  totalsByView: Record<SavingsView, number>; // realized, structural, naive(=both)
  hasData: boolean;
};

const EMPTY: CostsReport = {
  levers: [],
  spend: [],
  totalSpentUsd: 0,
  totalsByView: { realized: 0, structural: 0, naive: 0 },
  hasData: false,
};

// Account-wide rollup (summed across every config) for the /appraise Costs
// section. Unknown lever/surface rows (hand-edited, or a lever retired from the
// registry) are skipped rather than shown label-less. Missing tables → EMPTY.
export async function getCostsReport(): Promise<CostsReport> {
  try {
    const [savingsRows, spendRows] = await Promise.all([
      sql<{ lever: string; events: string; tokens: string; saved: string }[]>`
        select lever,
               sum(event_count)  as events,
               sum(tokens_saved) as tokens,
               sum(saved_usd)    as saved
        from savings_totals
        group by lever
      `,
      sql<{ surface: string; tokens: string; spent: string }[]>`
        select surface,
               sum(tokens)    as tokens,
               sum(spent_usd) as spent
        from spend_totals
        group by surface
      `,
    ]);

    const levers: LeverRow[] = savingsRows
      .filter((r) => r.lever in LEVERS)
      .map((r) => {
        const meta = LEVERS[r.lever as LeverId];
        return {
          lever: r.lever as LeverId,
          label: meta.label,
          category: meta.category,
          basis: meta.basis,
          events: Number(r.events),
          tokensSaved: Number(r.tokens),
          savedUsd: Number(r.saved),
        };
      })
      .sort((a, b) => b.savedUsd - a.savedUsd);

    const spend: SpendRow[] = spendRows
      .filter((r) => r.surface in SURFACE_LABELS)
      .map((r) => ({
        surface: r.surface as Surface,
        label: SURFACE_LABELS[r.surface as Surface],
        tokens: Number(r.tokens),
        spentUsd: Number(r.spent),
      }))
      .sort((a, b) => b.spentUsd - a.spentUsd);

    const realized = levers
      .filter((l) => l.category === "realized")
      .reduce((s, l) => s + l.savedUsd, 0);
    const structural = levers
      .filter((l) => l.category === "structural")
      .reduce((s, l) => s + l.savedUsd, 0);

    return {
      levers,
      spend,
      totalSpentUsd: spend.reduce((s, r) => s + r.spentUsd, 0),
      totalsByView: { realized, structural, naive: realized + structural },
      hasData: levers.length > 0 || spend.length > 0,
    };
  } catch (err) {
    if (isMissingTable(err)) return EMPTY;
    throw err;
  }
}
