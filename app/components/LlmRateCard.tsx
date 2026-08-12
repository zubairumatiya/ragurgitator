// Appraise → Models, section B: what each ANSWER-GENERATION model costs.
//
// The sibling of ModelRateCard, and the same shape — a Server Component with no
// client state, reading the registry and the price table rather than the DB, so it
// says something useful before you've run anything.
//
// Why it exists at all: LLM_PRICES has driven the spend ledger since 0034 but was
// never rendered anywhere. You could see what a model HAD cost you on the Costs tab,
// but not what one WOULD cost before choosing it — and the Settings LLM picker now
// offers eleven models across two providers.
import { InfoDot } from "@/app/components/InfoDot";
import type { LlmRateCardRow } from "@/lib/rag/modelAppraisal";
import { RATES_VERIFIED_ON } from "@/lib/rag/pricing";

const ABOUT =
  "List price per 1M tokens for every answer-generation model, so you can see " +
  "what a config's LLM choice costs before you make it.\n\n" +
  "Sorted by OUTPUT price, because that's what dominates the bill here: this " +
  "app sends a few thousand tokens of retrieved context and gets a short answer " +
  "back, so the output rate is what separates a cheap model from an expensive " +
  "one in practice.\n\n" +
  "Two caveats the table can't show. Claude Sonnet 5 is on introductory pricing " +
  "(2 / 10) through 2026-08-31 — the standing 3 / 15 rate is what's listed, so " +
  "it over-counts until then. And OpenAI charges roughly double above 272K " +
  "input tokens; this app's prompts never get close, so only the short-context " +
  "rate is shown.";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

// Rates here span 0.20 → 30 USD/1M, so a fixed 2dp would render the cheap tier
// as "$0.20" and the flagship as "$30.00" — fine — but a future sub-cent rate
// would collapse to "$0.00". Two decimals is right for everything registered
// today; the guard keeps a smaller rate from silently displaying as free.
function fmtRate(usdPerM: number | null): string {
  if (usdPerM === null) return "—";
  if (usdPerM > 0 && usdPerM < 0.01) return "<$0.01";
  return `$${usdPerM.toFixed(2)}`;
}

export function LlmRateCard({ rows }: { rows: LlmRateCardRow[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
        LLM rate card
        <InfoDot text={ABOUT} />
      </h2>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>Model</Th>
              <Th>Provider</Th>
              <Th right>In $ / 1M</Th>
              <Th right>Out $ / 1M</Th>
              <Th right>Context</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {/* Already sorted by output rate in listLlmRateCard — the ordering
                is a claim about what dominates spend here, so it belongs with
                the data, not with the markup. */}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {r.label}
                  {r.note && (
                    <span className="ml-1.5 text-xs font-normal text-zinc-400 dark:text-zinc-500">
                      {r.note}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{r.provider}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {fmtRate(r.inputPerM)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {fmtRate(r.outputPerM)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {compact.format(r.contextTokens)}
                </td>
                <td className="px-3 py-2">
                  {r.available ? (
                    <span className="text-green-700 dark:text-green-400">Available</span>
                  ) : (
                    <span
                      className="text-zinc-400 dark:text-zinc-500"
                      title={r.reason ?? undefined}
                    >
                      Needs key
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Prices verified {RATES_VERIFIED_ON}; check the provider before quoting.
        Every model here is billed to <em>your</em> key — add one per provider on
        the Account page.
      </p>
    </section>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
