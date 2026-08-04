// Trial times — the autotune speed history on /appraise/trials (migration 0041).
//
// One row per trial label: the MEDIAN of that group's runs, split into the four
// phases, plus the delta against the OLDEST group (the baseline you started
// from). Groups come pre-medianed from autotuneStore.listTrialRuns; this only
// formats them.
//
// A Server Component on purpose — the per-run breakdown uses <details>, so
// expanding a group costs no client JS at all.
import { InfoDot } from "@/app/components/InfoDot";
import type { TrialGroup } from "@/lib/rag/autotuneStore";

const ABOUT =
  "Wall clock for each timed autotune run, grouped by trial label and reduced " +
  "to a median (not a mean — this work is network-bound with a long right " +
  "tail, so one slow run would drag an average enough to look like a " +
  "regression).\n\n" +
  "search = the trial dry-runs and their embeds. confirm = persisting a " +
  "candidate and re-scoring it through real retrieval, including the re-score " +
  "on a revert. rescore = the run-end ripple. other = everything unaccounted " +
  "(getSummary, splitText); a large 'other' is a finding, not an error.\n\n" +
  "Δ compares each group's median against the oldest group. Groups are only " +
  "comparable if they faced the same workload — a ⚠ means they didn't.";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function Delta({ current, baseline }: { current: number; baseline: number }) {
  if (baseline === 0) return <span className="text-zinc-400">—</span>;
  const pct = (current / baseline - 1) * 100;
  // Under a percent is noise at this scale; don't dress it up with a sign.
  if (Math.abs(pct) < 1) return <span className="text-zinc-400">≈</span>;
  const faster = pct < 0;
  return (
    <span
      className={
        faster ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
      }
    >
      {faster ? "−" : "+"}
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

export default function TrialsSection({ groups }: { groups: TrialGroup[] }) {
  if (groups.length === 0) {
    return (
      <>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-black dark:text-zinc-50">
          Trial times
          <InfoDot text={ABOUT} />
        </h2>
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No timed runs yet for this config.
          <div className="mt-2 font-mono text-xs text-zinc-400">
            npx tsx scripts/autotune-trial.ts --runs 3 --label baseline --warmup
          </div>
        </div>
      </>
    );
  }

  // Oldest group = the baseline everything else is measured against. The store
  // returns newest-first, so it's the last one.
  const baseline = groups[groups.length - 1];

  return (
    <>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-black dark:text-zinc-50">
        Trial times
        <InfoDot text={ABOUT} />
      </h2>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="py-2 pl-4 pr-3 font-medium">Trial</th>
              <th className="py-2 pr-3 text-right font-medium">Runs</th>
              <th className="py-2 pr-3 text-right font-medium">Median</th>
              <th className="py-2 pr-3 text-right font-medium">Δ</th>
              <th className="py-2 pr-3 text-right font-medium">search</th>
              <th className="py-2 pr-3 text-right font-medium">confirm</th>
              <th className="py-2 pr-3 text-right font-medium">rescore</th>
              <th className="py-2 pr-3 text-right font-medium">other</th>
              <th className="py-2 pr-4 text-right font-medium">Targeted</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.label} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="py-2 pl-4 pr-3">
                  <details>
                    <summary className="cursor-pointer font-mono text-xs">
                      {g.label}
                      {!g.targetedStable && (
                        <span
                          className="ml-1 text-amber-600 dark:text-amber-400"
                          title="Targeted count differed between runs — these runs faced different workloads, so the median is not meaningful."
                        >
                          ⚠
                        </span>
                      )}
                    </summary>
                    <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-500">
                      {g.runs.map((r) => (
                        <div key={r.id}>
                          {r.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {secs(r.durationMs)} ·{" "}
                          {secs(r.searchMs)}/{secs(r.confirmMs)}/{secs(r.rescoreMs)}/{secs(r.otherMs)} ·{" "}
                          {r.attempts} attempts · {r.resolved} resolved
                        </div>
                      ))}
                    </div>
                  </details>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">{g.runs.length}</td>
                <td className="py-2 pr-3 text-right font-medium tabular-nums">
                  {secs(g.medianDurationMs)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {g.label === baseline.label ? (
                    <span className="text-zinc-400">base</span>
                  ) : (
                    <Delta current={g.medianDurationMs} baseline={baseline.medianDurationMs} />
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                  {secs(g.medianSearchMs)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                  {secs(g.medianConfirmMs)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                  {secs(g.medianRescoreMs)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-zinc-500">
                  {secs(g.medianOtherMs)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-zinc-500">
                  {g.runs[0].targeted}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-zinc-400">
        Δ is against <span className="font-mono">{baseline.label}</span>, the oldest group. Two
        groups only compare if Targeted matches — a different workload makes the medians
        measure different jobs.
      </p>
    </>
  );
}
