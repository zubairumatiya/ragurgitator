"use client";

// Costs — the savings "spreadsheet" on /appraise (docs/savings-accounting-plan.md).
// Server-computed CostsReport comes in as a prop; the only client state is which
// VIEW is selected. Realized = toggle-attributable levers (cascade, semantic
// cache, batch); Structural = always-on ones (embed cache, bucket-nDCG); Naive =
// both. Switching the view filters the lever rows and the headline total — no
// refetch, all three totals are already in the report.
import { useState } from "react";

import type { CostsReport, LeverRow, SavingsView } from "@/lib/rag/savingsStore";

const VIEWS: { id: SavingsView; label: string; blurb: string }[] = [
  { id: "naive", label: "Naive", blurb: "vs. an app with none of these optimizations" },
  { id: "realized", label: "Realized", blurb: "savings from toggles you turned on" },
  { id: "structural", label: "Structural", blurb: "always-on architectural savings" },
];

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // Fractions of a cent are normal at this scale — don't round them to $0.00.
  const body = abs < 0.01 && abs > 0 ? abs.toFixed(4) : abs.toFixed(2);
  return `${sign}$${body}`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export default function CostsSection({ report }: { report: CostsReport }) {
  const [view, setView] = useState<SavingsView>("naive");

  const rows =
    view === "naive"
      ? report.levers
      : report.levers.filter((l) => l.category === view);
  const savedTotal = report.totalsByView[view];

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
          💰 Costs
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Money saved by each savings lever, across all configs, itemized into one
          total. Pick a view: what the toggles bought you (<em>Realized</em>), what
          the architecture saves for free (<em>Structural</em>), or both
          (<em>Naive</em>).
        </p>
      </header>

      {!report.hasData ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No costs recorded yet. Once you chat, run evals, or ingest with the 0034
          tables applied, spend and savings start accruing here.
        </div>
      ) : (
        <>
          {/* View selector */}
          <div className="flex flex-wrap items-center gap-2">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                title={v.blurb}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  view === v.id
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* Headline tiles */}
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <Tile
              label={`Saved · ${view}`}
              value={fmtUsd(savedTotal)}
              accent={savedTotal >= 0 ? "green" : "red"}
            />
            <Tile label="Spent" value={fmtUsd(report.totalSpentUsd)} accent="zinc" />
          </div>

          {/* Itemized savings */}
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <Th>Lever</Th>
                  <Th>Type</Th>
                  <Th right>Events</Th>
                  <Th right>Tokens saved</Th>
                  <Th right>Saved</Th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-4 text-center text-zinc-400"
                    >
                      No {view} savings recorded yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((l) => <LeverTr key={l.lever} row={l} />)
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-zinc-200 font-medium dark:border-zinc-800">
                    <td className="px-3 py-2" colSpan={4}>
                      Total ({view})
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        savedTotal >= 0
                          ? "text-green-700 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {fmtUsd(savedTotal)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Gross spend by surface */}
          {report.spend.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Spend by surface
              </h3>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                    <tr>
                      <Th>Surface</Th>
                      <Th right>Tokens</Th>
                      <Th right>Spent</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.spend.map((s) => (
                      <tr
                        key={s.surface}
                        className="border-t border-zinc-100 dark:border-zinc-800"
                      >
                        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                          {s.label}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                          {compact.format(s.tokens)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                          {fmtUsd(s.spentUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Levers marked <span className="text-zinc-500 dark:text-zinc-400">~</span>{" "}
            use estimated token counts (≈4 chars/token); the rest use real provider
            usage. Totals sum per-lever savings measured independently, so they
            don&apos;t equal a single controlled experiment.
          </p>
        </>
      )}
    </section>
  );
}

function LeverTr({ row }: { row: LeverRow }) {
  const negative = row.savedUsd < 0;
  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-800">
      <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
        {row.label}
        {row.basis === "estimate" && (
          <span className="text-zinc-400" title="Estimated token counts">
            {" "}
            ~
          </span>
        )}
      </td>
      <td className="px-3 py-2 capitalize text-zinc-500 dark:text-zinc-400">
        {row.category}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
        {compact.format(row.events)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
        {compact.format(row.tokensSaved)}
      </td>
      <td
        className={`px-3 py-2 text-right tabular-nums ${
          negative
            ? "text-red-600 dark:text-red-400"
            : "text-green-700 dark:text-green-400"
        }`}
      >
        {fmtUsd(row.savedUsd)}
      </td>
    </tr>
  );
}

function Tile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "green" | "red" | "zinc";
}) {
  const color =
    accent === "green"
      ? "text-green-700 dark:text-green-400"
      : accent === "red"
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-900 dark:text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="text-xs capitalize text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
