// Appraise → Models, section A: what each embedding model costs per token.
//
// A Server Component with no client state — there are no filters in v1 (see
// docs/appraise-model-comparison-plan.md §5), so nothing here needs "use client".
//
// This is the half of the page that's fully populated on first open: it reads
// the registry and the price table, not the DB, so it says something useful
// before you've run a single eval.
import { InfoDot } from "@/app/components/InfoDot";
import type { RateCardRow } from "@/lib/rag/modelAppraisal";
import { RATES_VERIFIED_ON } from "@/lib/rag/pricing";

const ABOUT =
  "List price per 1M tokens for every embedding model the app knows about, so " +
  "you don't have to go to the provider's site.\n\n" +
  "A dash means we won't quote a figure: today that's text-embedding-3-large, " +
  "where OpenAI's model card ($0.13) and pricing page ($0.065) disagree. Cost " +
  "accounting still charges it at $0.13 — the dash is about what we'll claim, " +
  "not what we count.";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function fmtRate(usdPerM: number | null): string {
  if (usdPerM === null) return "—";
  if (usdPerM === 0) return "free";
  return `$${usdPerM.toFixed(2)}`;
}

export function ModelRateCard({
  rows,
  meteredEmbedTokens,
}: {
  rows: RateCardRow[];
  meteredEmbedTokens: number;
}) {
  // Cheapest priced model first; unpriced and free ones after, so the column
  // reads as a ladder. Free (local) models sort with 0 naturally; the dash sorts
  // last because it isn't a price at all.
  const sorted = [...rows].sort((a, b) => {
    if (a.usdPerM === null && b.usdPerM === null) return a.id.localeCompare(b.id);
    if (a.usdPerM === null) return 1;
    if (b.usdPerM === null) return -1;
    if (a.usdPerM !== b.usdPerM) return a.usdPerM - b.usdPerM;
    return a.id.localeCompare(b.id);
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
        🏷️ Rate card
        <InfoDot text={ABOUT} />
      </h2>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>Model</Th>
              <Th>Provider</Th>
              <Th right>Dim</Th>
              <Th right>$ / 1M tokens</Th>
              <Th right>Free tier</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {r.id}
                </td>
                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{r.provider}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.dimension}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300"
                  title={
                    r.usdPerM === null
                      ? "No price we can stand behind — OpenAI's model card and pricing page disagree"
                      : undefined
                  }
                >
                  {fmtRate(r.usdPerM)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {r.freeTierM === null ? "—" : `${r.freeTierM}M`}
                </td>
                <td className="px-3 py-2">
                  <Status row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Prices and free-tier allowances verified {RATES_VERIFIED_ON}; check the
        provider before quoting.{" "}
        {/* The usage half is deliberately narrow: spend_totals counts what THIS
            app metered since 0034, not per model, and not the provider's
            free-tier counter — Voyage's allowance is per account and covers
            every other use of the key. Don't turn this into a "% used" bar. */}
        This app has metered{" "}
        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
          {compact.format(meteredEmbedTokens)}
        </span>{" "}
        embed tokens, so at current volume the Voyage models are still inside
        their free allowance — your account may have used more elsewhere.
      </p>
    </section>
  );
}

function Status({ row }: { row: RateCardRow }) {
  if (!row.available) {
    // Local models need no credential — they're gated behind LOCAL_EMBEDDINGS
    // because they download multi-hundred-MB weights on first use and can't run
    // on serverless hosts. Calling that "needs key" would be plainly wrong.
    return (
      <span className="text-zinc-400 dark:text-zinc-500" title={row.reason ?? undefined}>
        {row.provider === "local" ? "Opt-in" : "Needs key"}
      </span>
    );
  }
  if (!row.ingestable) {
    // Usable in the in-memory experiments, but can't be a config's base_model
    // until it has a chunks_<model>_<dim> table. That distinction is exactly
    // what the comparison table below scores, so it's worth surfacing.
    return (
      <span
        className="text-zinc-500 dark:text-zinc-400"
        title="No vector table yet — usable in trials, but not as a config's base model"
      >
        Experiments only
      </span>
    );
  }
  return <span className="text-green-700 dark:text-green-400">Available</span>;
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
