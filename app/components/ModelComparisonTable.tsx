// Appraise → Models, section B: how each embedding model has actually scored here.
//
// Server Component, no client state (no filters in v1 — plan §5).
//
// THE BADGE IS THE POINT. Recall is hit_count/question_count in both sources;
// what differs is the denominator's scope, and that difference is the whole
// story of how much the number is worth:
//
//   🟢 full corpus  — eval_runs. Recall over the entire corpus. The real thing.
//   🔴 partial      — eval_model_trials. Recall inside the trial's candidate
//                     pool, which contains the correct chunk by construction
//                     (0006: "It is NOT a live score"). Runs near 100%.
//
// So the rows are sorted, but the ordering is NOT a ranking anyone should act
// on while every pool row sits at the ceiling — hence no best-value highlight
// here, unlike /appraise/configs.
import { InfoDot } from "@/app/components/InfoDot";
import type { EvidenceScope, ModelPerformanceRow } from "@/lib/rag/modelAppraisal";

const ABOUT =
  "Recall is hits ÷ questions in both cases — what differs is the scope.\n\n" +
  "🟢 full corpus: measured over the whole corpus, from a config's frozen eval " +
  "run.\n" +
  "🔴 partial corpus: measured inside a trial's small candidate pool, which " +
  "already contains the right chunk — so it runs near 100% and can't separate " +
  "models. Treat it as 'tried, didn't break', not as a ranking.\n\n" +
  "A model listed with no numbers has trials that varied chunking as well as " +
  "the model, so nothing can be attributed to the model alone.";

function fmt3(n: number | null): string {
  return n === null ? "—" : n.toFixed(3);
}

export function ModelComparisonTable({ rows }: { rows: ModelPerformanceRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <Heading />
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No model has been scored yet. Run <strong>Process new chunks</strong> on
          a config&apos;s Eval tab, or try an alternate model from a chunk in the
          Eval view — results land here.
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <Heading />
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>Model</Th>
              <Th>Scope</Th>
              <Th right>Recall</Th>
              <Th right>MRR</Th>
              <Th right>nDCG</Th>
              <Th right>vs. base</Th>
              <Th right>Questions</Th>
              <Th>Evidence</Th>
              <Th right>$ / 1M</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.model}:${r.scope}`}
                className="border-t border-zinc-100 dark:border-zinc-800"
              >
                <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                  {r.model}
                </td>
                <td className="px-3 py-2">
                  <ScopeBadge scope={r.scope} />
                </td>
                <Num value={fmt3(r.recall)} strong={r.recall !== null} />
                <Num value={fmt3(r.mrr)} />
                <Num value={fmt3(r.ndcg)} />
                <td className="px-3 py-2 text-right tabular-nums">
                  <Delta value={r.baselineDelta} />
                </td>
                <Num value={r.questions > 0 ? String(r.questions) : "—"} />
                <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <Evidence row={r} />
                </td>
                <Num value={r.usdPerM === null ? "—" : `$${r.usdPerM.toFixed(2)}`} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Heading() {
  return (
    <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
      📈 Measured performance
      <InfoDot text={ABOUT} />
    </h2>
  );
}

function ScopeBadge({ scope }: { scope: EvidenceScope }) {
  if (scope === "full") {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-950 dark:text-green-400">
        full corpus
      </span>
    );
  }
  if (scope === "pool") {
    return (
      <span
        className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400"
        title="Measured inside a trial's candidate pool, not the full corpus"
      >
        partial corpus
      </span>
    );
  }
  return <span className="text-xs text-zinc-400 dark:text-zinc-600">—</span>;
}

// Paired trial-vs-baseline hit delta. Not a percentage — it's "N more questions
// hit than the stored baseline, on the same questions and the same pool", which
// is the one number in the trial data measured against a genuine control.
function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-zinc-400 dark:text-zinc-600">—</span>;
  if (value === 0) return <span className="text-zinc-500 dark:text-zinc-400">0</span>;
  const positive = value > 0;
  return (
    <span
      className={
        positive ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
      }
      title="Questions hit vs. the stored baseline, same questions and pool"
    >
      {positive ? "+" : ""}
      {value}
    </span>
  );
}

function Evidence({ row }: { row: ModelPerformanceRow }) {
  const date = row.lastAt ? new Date(row.lastAt).toLocaleDateString() : null;
  if (row.scope === "full") {
    const n = row.configs ?? 0;
    return (
      <>
        {n} config{n === 1 ? "" : "s"}
        {date ? ` · ${date}` : ""}
      </>
    );
  }
  if (row.scope === "pool") {
    return (
      <>
        {row.trials} trial{row.trials === 1 ? "" : "s"} · {row.chunks} chunk
        {row.chunks === 1 ? "" : "s"}
        {date ? ` · ${date}` : ""}
      </>
    );
  }
  // scope "none": trials exist but all varied chunking too, so nothing is
  // attributable. Say which, rather than leaving the row unexplained.
  return <span className="italic">trials varied chunking too</span>;
}

function Num({ value, strong }: { value: string; strong?: boolean }) {
  return (
    <td
      className={`px-3 py-2 text-right tabular-nums ${
        strong ? "text-zinc-800 dark:text-zinc-200" : "text-zinc-500 dark:text-zinc-400"
      }`}
    >
      {value}
    </td>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
