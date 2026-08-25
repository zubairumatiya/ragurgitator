// Appraise → Models, section B: full-corpus retrieval quality per embedding model,
// from the offline replay (0043).
//
// This REPLACED a table built on eval_model_trials. That one re-ranked inside a
// candidate pool containing the right chunk by construction, so all seven models
// scored 1.000 and it could not rank anything. The replay ranks the whole corpus for
// every model, on the same questions, by the same exact-cosine scan — and
// immediately produced a real spread (MRR .800–.881).
//
// Server Component. Only the scatter below it is a Client Component, for its y-axis
// metric selector.
//
// R@1 and MRR lead on purpose. R@5/R@10 are near the ceiling on this corpus
// (0.92–1.00), which is exactly why the config's stored eval run reads 1.000 — its k
// sits above where these models actually differ.
import { InfoDot } from "@/app/components/InfoDot";
import { ModelCostQualityChart } from "@/app/components/ModelCostQualityChart";
import type { ConfigComparison } from "@/lib/rag/appraiseStore";
import { embedRate } from "@/lib/rag/pricing";
import type { ReplayReport, ReplayRow } from "@/lib/rag/replayStore";

const ABOUT =
  "Every model ranked against the SAME full corpus, the same labelled " +
  "questions, and the same exact-cosine scan — only the model changes. Computed " +
  "from embedding vectors already cached, so it costs nothing to run.\n\n" +
  "R@1 and MRR are the columns that separate models here; R@5 is near the " +
  "ceiling on this corpus.\n\n" +
  "This is a brute-force scan, not the live ANN index, so it measures the model " +
  "rather than the full retrieval stack. A model is scored only when it has a " +
  "cached vector for every chunk — partial coverage would shrink the pool and " +
  "flatter the score.\n\n" +
  "RANK BY MRR AND R@1, not nDCG. Those score against the labelled gold chunk, " +
  "which no embedding model had a hand in choosing. nDCG grades against the " +
  "ideal ranking, which is itself an average of several models' opinions — a " +
  "model marked * helped build the ideal it is graded on, so that ideal is " +
  "rebuilt without its votes. The correction is even-handed only when every " +
  "candidate votes; a ranking built by a narrow set still favours that family.";

function f3(n: number | null): string {
  return n === null ? "—" : n.toFixed(3);
}

// List price for a model, or "—" when we have no figure we'd stand behind.
function priceLabel(model: string): string {
  const rate = embedRate(model);
  if (!rate || !rate.verified) return "—";
  return rate.usdPerM === 0 ? "free" : `$${rate.usdPerM.toFixed(2)}`;
}

export function ModelReplayTable({
  reports,
  comparisons,
  // Replaces the "generate some questions" empty state when the table is empty
  // for a reason other than having no data — currently only the demo, where the
  // replay is not run at all because it pulls every cached vector back out of
  // the database. Without this the demo would tell a visitor to go and label
  // questions, which is both wrong and something they cannot do.
  emptyNote,
  // Rendered once under the heading when the table IS populated but the numbers
  // were computed somewhere else — currently only the demo, where the publish
  // carries the replay's result because a guest cannot compute one (phase 6.3).
  // A measurement that cannot move should say so; otherwise a visitor reads
  // seventeen live-looking rows and reasonably assumes their own workspace
  // produced them.
  publishedNote,
}: {
  reports: ReplayReport[];
  comparisons: ConfigComparison[];
  emptyNote?: string;
  publishedNote?: string;
}) {
  if (reports.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <Heading />
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          {emptyNote ??
            "No config has labelled eval questions yet. Generate questions and label them on a config's Eval tab — every model with cached vectors is then scored here for free."}
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <Heading />
      {publishedNote && (
        <p className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-xs leading-relaxed text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          {publishedNote}
        </p>
      )}
      {reports.map((r) => (
        <ConfigReplay
          key={r.configId}
          report={r}
          live={comparisons.find((c) => c.configId === r.configId) ?? null}
        />
      ))}
    </section>
  );
}

function Heading() {
  return (
    <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
      Full-corpus replay
      <InfoDot text={ABOUT} />
    </h2>
  );
}

function ConfigReplay({
  report,
  live,
}: {
  report: ReplayReport;
  live: ConfigComparison | null;
}) {
  // Best value per metric, highlighted like /appraise/configs does. Only
  // meaningful with >=2 scored models, otherwise the single row is trivially
  // "best" and the green reads as an endorsement it hasn't earned.
  const best = (key: "recallAt1" | "recallAt5" | "mrr" | "ndcg"): number | null => {
    const vals = report.rows.map((r) => r[key]).filter((v): v is number => v !== null);
    return vals.length >= 2 ? Math.max(...vals) : null;
  };
  const bests = {
    recallAt1: best("recallAt1"),
    recallAt5: best("recallAt5"),
    mrr: best("mrr"),
    ndcg: best("ndcg"),
  };
  const anyLeaveOneOut = report.rows.some((r) => r.ndcgLeaveOneOut);
  const baseModel = live?.baseModel ?? null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-zinc-500">
        <span className="text-zinc-800 dark:text-zinc-200">{report.configLabel}</span>
        <span className="text-zinc-400">
          {" · "}
          {report.corpusChunks} chunks · {report.questions} questions
        </span>
      </h3>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>Model</Th>
              <Th right>R@1</Th>
              <Th right>R@5</Th>
              <Th right>MRR</Th>
              <Th right>nDCG@k</Th>
              <Th right>$ / 1M</Th>
              <Th>Coverage</Th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <Row
                key={row.model}
                row={row}
                bests={bests}
                isBase={row.model === baseModel}
              />
            ))}
          </tbody>
        </table>
      </div>

      {anyLeaveOneOut && (
        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          <span className="text-zinc-700 dark:text-zinc-300">*</span> This model
          helped build the ideal ranking that nDCG grades against, so its nDCG is
          scored against an ideal rebuilt from the other voters only. Who votes
          is set per config under Settings → Metrics → nDCG → Models in
          aggregate. Rankings built before that setting changed keep their
          original voters until rebuilt — rank by MRR and R@1, which score
          against the labelled gold chunk instead.
        </p>
      )}

      <ModelCostQualityChart rows={report.rows} baseModel={baseModel} />

      {live && <LiveNote live={live} report={report} />}
    </div>
  );
}

type Bests = { recallAt1: number | null; recallAt5: number | null; mrr: number | null; ndcg: number | null };

function Row({
  row,
  bests,
  isBase,
}: {
  row: ReplayRow;
  bests: Bests;
  isBase: boolean;
}) {
  const unscored = row.mrr === null;
  return (
    <tr className="border-t border-zinc-100 dark:border-zinc-800">
      <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
        {row.model}
        {isBase && (
          <span
            className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            title="This config's current base model"
          >
            in use
          </span>
        )}
      </td>
      <Metric value={row.recallAt1} best={bests.recallAt1} />
      <Metric value={row.recallAt5} best={bests.recallAt5} />
      <Metric value={row.mrr} best={bests.mrr} />
      <Metric value={row.ndcg} best={bests.ndcg}>
        {row.ndcgLeaveOneOut && (
          <span
            className="ml-1 font-normal text-zinc-400"
            title="This model helped build the ideal ranking, so it was scored against an ideal rebuilt without its own votes"
          >
            *
          </span>
        )}
      </Metric>
      {/* Price sits in the same row as quality so the trade-off is one glance,
          not two tables. Unverified rates render "—" here exactly as they do on
          the rate card — see EmbedRate.verified. */}
      <Num value={priceLabel(row.model)} />
      <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
        {unscored ? (
          <span title="Not every chunk is embedded under this model, so it can't be scored without inflating the result">
            {row.coverageChunks}/{row.corpusChunks} chunks cached
          </span>
        ) : (
          <span className="text-green-700 dark:text-green-400">complete</span>
        )}
      </td>
    </tr>
  );
}

// The stored eval run for this config's base model, measured through the REAL
// retriever (ANN index, fusion, screens) rather than a brute-force scan. Worth
// stating next to the replay precisely because the two disagree: the live stack
// scores better than raw cosine on the identical model, which is the retrieval
// pipeline earning its keep. Conflating the two numbers would hide that.
function LiveNote({ live, report }: { live: ConfigComparison; report: ReplayReport }) {
  const replayBase = report.rows.find((r) => r.model === live.baseModel);
  if (!replayBase || replayBase.mrr === null || live.mrr === null) return null;
  return (
    <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
      Live eval run for <span className="text-zinc-700 dark:text-zinc-300">{live.baseModel}</span>{" "}
      scores MRR{" "}
      <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
        {live.mrr.toFixed(3)}
      </span>{" "}
      vs. the replay&apos;s{" "}
      <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
        {replayBase.mrr.toFixed(3)}
      </span>{" "}
      — the live number goes through the real retriever (ANN index, fusion,
      screens), the replay is a plain cosine scan. Compare models by the replay
      column; compare pipelines by the live one.
    </p>
  );
}

// One metric cell, highlighting the column's best value — same treatment across
// every metric column, so no column looks more authoritative than another purely
// because it's the one that's coloured.
function Metric({
  value,
  best,
  children,
}: {
  value: number | null;
  best: number | null;
  children?: React.ReactNode;
}) {
  const isBest = value !== null && best !== null && value === best;
  return (
    <td
      className={`px-3 py-2 text-right tabular-nums ${
        isBest
          ? "font-semibold text-green-700 dark:text-green-400"
          : "text-zinc-500 dark:text-zinc-400"
      }`}
    >
      {f3(value)}
      {children}
    </td>
  );
}

function Num({ value }: { value: string }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
      {value}
    </td>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
