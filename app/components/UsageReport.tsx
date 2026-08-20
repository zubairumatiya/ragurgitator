// UI: the /usage rendering of the provider-key ledger (0072).
//
// A Server Component with no client state — deliberately. Everything here is a
// static read of a report the page already fetched, and the one thing that would
// normally force "use client" is timestamp formatting.
//
// TIMES ARE RENDERED IN UTC, labelled as such, rather than in the viewer's
// locale. That is not a hydration dodge (though it is also that): this page
// exists to be read SIDE BY SIDE with a provider's own usage dashboard, and every
// provider reports usage in UTC days. A row stamped in local time would have to
// be mentally re-based before it could be compared with the thing it is meant to
// be compared against, and the daily rollup underneath it is already grouped
// `at time zone 'UTC'`. One clock, stated once.
import type {
  KeyUsageDay,
  KeyUsageReport,
  KeyUsageWindow,
  KeyUsageRow,
  KeyUsageTotal,
} from "@/lib/auth/keyUsageStore";

// Fractions of a cent are normal at this scale — a per-call ledger is mostly
// made of them, and rounding them to $0.00 would make the rows look free. Same
// rule as CostsSection.
function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  return `$${abs < 0.01 && abs > 0 ? abs.toFixed(4) : abs.toFixed(2)}`;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const utcStamp = (ms: number) =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export function UsageReport({ report }: { report: KeyUsageReport }) {
  return (
    <div className="flex flex-col gap-8">
      {/* AT THE TOP, not in a footnote, because a reconciliation that assumes
          exactness and finds a 3% gap would go looking for a breach that isn't
          there. It says WHICH numbers are approximate rather than disclaiming all
          of them: generation rows carry the provider's own reported usage and are
          exact, embedding rows are counted at chars/4 (the same basis the savings
          ledger uses) because the three embedding APIs report usage in three
          different shapes. Costs inherit whatever their tokens were.

          What is exact everywhere is the part that catches a compromised key —
          how many calls were made, when, with which key, and which ones were
          rejected. That distinction is the whole reason to name the limitation
          instead of hedging the page. */}
      <p className="max-w-prose rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
        <span className="font-medium">Token and cost figures are estimates.</span>{" "}
        Generation calls report their real usage, but embedding tokens are counted
        from text length, so totals will not match your provider&rsquo;s to the
        penny. Call counts, timestamps and rejections are exact — expect small
        differences in the money column, and investigate differences in the number
        of calls.
      </p>

      <section className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:max-w-lg">
          <Tile label={`Calls · ${report.windowDays}d`} value={compact.format(report.totalCalls)} />
          <Tile
            label="Rejected"
            value={compact.format(report.totalFailures)}
            // Zero rejected calls is the unremarkable case and should read as
            // such; any other number is worth a second look, so it is the only
            // tile that ever takes a colour.
            accent={report.totalFailures > 0 ? "red" : "zinc"}
          />
          <Tile label="Cost" value={fmtUsd(report.totalCostUsd)} />
        </div>
      </section>

      <Totals totals={report.totals} />
      <DailyStrip days={report.days} axis={report.window} />
      <Rows report={report} />
    </div>
  );
}

// --- totals ------------------------------------------------------------------

function Totals({ totals }: { totals: KeyUsageTotal[] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>By provider and model</SectionHeading>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>Provider</Th>
              <Th>Model</Th>
              <Th right>Calls</Th>
              <Th right>Rejected</Th>
              <Th right>Input</Th>
              <Th right>Output</Th>
              <Th right>Cost</Th>
            </tr>
          </thead>
          <tbody>
            {totals.map((t) => (
              <tr
                key={`${t.provider}:${t.model}`}
                className="border-t border-zinc-100 dark:border-zinc-800"
              >
                <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {t.providerLabel}
                </td>
                {/* Control-plane calls (batch submit/poll/fetch/cancel) carry no
                    model at all, which is a fact about the call rather than
                    missing data. */}
                <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                  {t.model === "" ? <Muted title="No model — a batch control call">—</Muted> : t.model}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                  {compact.format(t.calls)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    t.failures > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-zinc-400 dark:text-zinc-500"
                  }`}
                >
                  {t.failures === 0 ? "—" : compact.format(t.failures)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {compact.format(t.inputTokens)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
                  {compact.format(t.outputTokens)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                  {fmtUsd(t.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- daily strip -------------------------------------------------------------

// The point of the strip is that a SPIKE is visible without reading 500 rows, so
// it is scaled by call count and shades the rejected share red. Cost is in the
// tooltip rather than the height: a day of cheap-model traffic and a day of one
// expensive call are equally interesting here, and only the former is a signal
// about how the key is being used.
//
// THE AXIS IS THE FULL WINDOW, always. It used to span only the first to the last
// day that had calls, which is fine at 30 days of traffic and degenerates badly
// below that: an account with calls on a single day got ONE bar, and one bar with
// flex-1 is a full-width, full-height grey slab with the same date printed at both
// ends. That reads as a broken component, not as "you used this once". A fixed
// 30-day axis makes the same data read as one day's activity in a quiet month.
//
// The bounds come from the server (report.window) rather than from Date.now()
// here, which react-hooks/purity forbids during render.
// `axis`, not `window`: this is a "use client" module, where a parameter named
// `window` shadows the browser global for the whole function body.
function DailyStrip({ days, axis }: { days: KeyUsageDay[]; axis: KeyUsageWindow }) {
  if (days.length === 0) return null;

  const filled = fillDays(days, axis);
  const peak = Math.max(...filled.map((d) => d.calls), 1);

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Calls per day</SectionHeading>
      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        {/* The scale, stated. Without it a bar's height is only meaningful
            relative to the other bars, and on a quiet window that is no
            information at all — one call and four hundred both draw a full-height
            bar. */}
        <div className="mb-1 text-[11px] text-zinc-400">
          peak {peak} call{peak === 1 ? "" : "s"}/day
        </div>
        <div className="flex h-24 items-end gap-1">
          {filled.map((d) => {
            const height = d.calls === 0 ? 0 : Math.max(2, (d.calls / peak) * 100);
            const failedShare = d.calls === 0 ? 0 : (d.failures / d.calls) * 100;
            return (
              <div
                key={d.day}
                title={`${d.day} — ${d.calls} call${d.calls === 1 ? "" : "s"}, ${
                  d.failures
                } rejected, ${fmtUsd(d.costUsd)}`}
                className="flex min-w-px flex-1 flex-col justify-end"
                style={{ height: "100%" }}
              >
                {d.calls === 0 ? (
                  // A day with no calls still needs to occupy its slot, or the
                  // strip stops being a time axis.
                  <div className="h-px w-full bg-zinc-200 dark:bg-zinc-800" />
                ) : (
                  <div
                    className="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-zinc-300 dark:bg-zinc-700"
                    style={{ height: `${height}%` }}
                  >
                    <div
                      className="w-full bg-red-500/70 dark:bg-red-500/60"
                      style={{ height: `${failedShare}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-zinc-400">
          <span>{filled[0].day}</span>
          <span>{filled[filled.length - 1].day}</span>
        </div>
      </div>
    </section>
  );
}

// Every day in the window gets a slot, with or without calls — see the note on
// DailyStrip for why the data's own extent is the wrong axis. Days outside the
// window are still emitted rather than dropped: `days` comes from the same
// filtered query, so a row outside these bounds would mean the two disagreed, and
// silently hiding it would hide the disagreement too.
function fillDays(days: KeyUsageDay[], axis: KeyUsageWindow): KeyUsageDay[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: KeyUsageDay[] = [];

  const start = days.length > 0 && days[0].day < axis.start ? days[0].day : axis.start;
  const end =
    days.length > 0 && days[days.length - 1].day > axis.end ? days[days.length - 1].day : axis.end;

  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const day = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, calls: 0, failures: 0, costUsd: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// --- raw rows ----------------------------------------------------------------

function Rows({ report }: { report: KeyUsageReport }) {
  const truncated = report.totalCalls > report.rowsShown;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>
        Every call
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-400">
          {truncated
            ? `most recent ${report.rowsShown} of ${report.totalCalls} in the last ${report.windowDays} days`
            : `${report.rowsShown} in the last ${report.windowDays} days`}
          {" · times in UTC"}
        </span>
      </SectionHeading>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>When</Th>
              <Th>Provider</Th>
              <Th>Model</Th>
              <Th>Doing</Th>
              <Th>Key</Th>
              <Th>Config</Th>
              <Th right>Tokens</Th>
              <Th right>Cost</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ row }: { row: KeyUsageRow }) {
  // A REJECTED CALL IS THE INTERESTING ROW, so it gets the tint rather than
  // being greyed out for having spent nothing. A run of these against a key you
  // are not using is the clearest signature the table can show.
  const failed = !row.ok;
  return (
    <tr
      className={`border-t border-zinc-100 dark:border-zinc-800 ${
        failed ? "bg-red-50/70 dark:bg-red-950/20" : ""
      }`}
    >
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-zinc-500 dark:text-zinc-400">
        {utcStamp(row.at)}
      </td>
      <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{row.providerLabel}</td>
      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
        {row.model === "" ? <Muted title="No model — a batch control call">—</Muted> : row.model}
      </td>
      {/* Surface says what the app was doing, kind says what call it made. Both,
          because "Chat answers / Message" and "Batch control / Batch poll" are
          different enough questions that collapsing them loses the second one. */}
      <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
        {row.surfaceLabel}
        <span className="text-zinc-400"> · {row.kindLabel}</span>
      </td>
      <td className="px-3 py-2 tabular-nums text-zinc-500 dark:text-zinc-400">
        {row.keyLastFour === "" ? (
          // NOT "no key was used" — a call cannot happen without one. The
          // client cache had already expired by the time the row was written,
          // so the last four were no longer in memory to record.
          <Muted title="The key's last four were no longer cached when this row was written. A key was used.">
            —
          </Muted>
        ) : (
          `••••${row.keyLastFour}`
        )}
      </td>
      <td className="max-w-[12rem] px-3 py-2 text-zinc-500 dark:text-zinc-400">
        {row.configLabel === null ? (
          // NO LABEL HAS TWO CAUSES AND THE ROW CANNOT TELL THEM APART, so it must
          // not claim either. config_id is null both when the config was deleted
          // (0072 sets null rather than cascading, so the ledger outlives it) and
          // when the call was simply not made under a config at all — the batch
          // poller and every account-level route run in a user scope with no
          // config in it. Naming this "deleted config" would invent a deletion for
          // the second case, which is the more common one. Either way it is a
          // normal state, not a broken row.
          <Muted title="No config recorded: either this call was not made under one, or the config has since been deleted. The record survives either way.">
            —
          </Muted>
        ) : (
          <div className="truncate">{row.configLabel}</div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
        {row.inputTokens === 0 && row.outputTokens === 0
          ? "—"
          : `${compact.format(row.inputTokens)} / ${compact.format(row.outputTokens)}`}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
        {row.costUsd === 0 ? <span className="text-zinc-400">—</span> : fmtUsd(row.costUsd)}
      </td>
      <td className="px-3 py-2">
        {failed ? (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/60 dark:text-red-400">
            {row.errorCode ?? "rejected"}
          </span>
        ) : (
          <span className="text-xs text-zinc-400">ok</span>
        )}
      </td>
    </tr>
  );
}

// --- small shared bits -------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{children}</h2>
  );
}

function Muted({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span className="text-zinc-400" title={title}>
      {children}
    </span>
  );
}

function Tile({
  label,
  value,
  accent = "zinc",
}: {
  label: string;
  value: string;
  accent?: "red" | "zinc";
}) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div
        className={`text-xl font-semibold tabular-nums ${
          accent === "red"
            ? "text-red-600 dark:text-red-400"
            : "text-zinc-900 dark:text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
