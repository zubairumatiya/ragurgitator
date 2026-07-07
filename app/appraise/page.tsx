// Appraise — the pinned cross-config view (a peer of the config tabs, not a
// config itself; see docs/multi-config-plan.md §6/§8 Phase 4). Reads every
// config's latest frozen eval-run snapshot (appraiseStore) and shows them side by
// side, grouped by corpus so same-corpus A/Bs sit together, with the best value
// per metric highlighted within each group. Standalone (outside /c/[configId]),
// so no per-config banner/sub-nav. Dynamic — it reads the DB per request.
import Link from "next/link";
import { listConfigComparisons, type ConfigComparison } from "@/lib/rag/appraiseStore";

export const dynamic = "force-dynamic";

export default async function AppraisePage() {
  const rows = await listConfigComparisons();

  // Group by corpus, preserving the store's (corpus, tab) ordering.
  // Detached configs (corpus deleted) group together under "No corpus".
  const groups: { corpusId: string; corpusName: string; configs: ConfigComparison[] }[] = [];
  for (const row of rows) {
    const corpusId = row.corpusId ?? "none";
    let g = groups.find((x) => x.corpusId === corpusId);
    if (!g) {
      g = { corpusId, corpusName: row.corpusName ?? "No corpus", configs: [] };
      groups.push(g);
    }
    g.configs.push(row);
  }

  const anyScored = rows.some((r) => r.recall !== null || r.ndcg !== null || r.mrr !== null);

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-6 px-8 py-12">
        <Link
          href="/"
          className="self-start text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Back to configs
        </Link>

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            📊 Appraise
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Latest eval metrics for every config, grouped by corpus. Best value per
            metric is highlighted within each corpus. Run <em>Process</em> /{" "}
            <em>Re-score</em> on a config&apos;s Eval tab to populate or refresh its row.
          </p>
        </header>

        {!anyScored && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No eval runs yet. Open a config, add documents, then run{" "}
            <strong>Process new chunks</strong> on its Eval tab — its metrics will
            appear here for comparison.
          </div>
        )}

        {groups.map((g) => (
          <CorpusGroup key={g.corpusId} name={g.corpusName} configs={g.configs} />
        ))}
      </main>
    </div>
  );
}

function CorpusGroup({ name, configs }: { name: string; configs: ConfigComparison[] }) {
  // Best value per metric within this corpus, only meaningful when ≥2 configs have it.
  const best = (key: "recall" | "mrr" | "ndcg"): number | null => {
    const vals = configs.map((c) => c[key]).filter((v): v is number => v !== null);
    return vals.length >= 2 ? Math.max(...vals) : null;
  };
  const bestRecall = best("recall");
  const bestMrr = best("mrr");
  const bestNdcg = best("ndcg");

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-zinc-500">
        Corpus: <span className="text-zinc-800 dark:text-zinc-200">{name}</span>
        <span className="text-zinc-400"> · {configs.length} config{configs.length === 1 ? "" : "s"}</span>
      </h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <Th>Config</Th>
              <Th>Model</Th>
              <Th>Chunk</Th>
              <Th right>k</Th>
              <Th right>Questions</Th>
              <Th right>Recall@k</Th>
              <Th right>MRR</Th>
              <Th right>nDCG@k</Th>
              <Th right>Last run</Th>
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <tr key={c.configId} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2">
                  {c.isOpen ? (
                    <Link
                      href={`/c/${c.configId}`}
                      className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {c.label}
                    </Link>
                  ) : (
                    <span className="font-medium text-zinc-500">
                      {c.label} <span className="text-xs font-normal text-zinc-400">(closed)</span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{c.baseModel}</td>
                <td className="px-3 py-2 tabular-nums text-zinc-600 dark:text-zinc-400">
                  {c.chunkSize}/{c.chunkOverlap}
                </td>
                <Td right muted>{c.topK}</Td>
                <Td right muted>{c.questionCount ?? "—"}</Td>
                <Metric value={c.recall} best={bestRecall} />
                <Metric value={c.mrr} best={bestMrr} />
                <Metric value={c.ndcg} best={bestNdcg} />
                <Td right muted>
                  {c.lastRunAt ? new Date(c.lastRunAt).toLocaleDateString() : "—"}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metric({ value, best }: { value: number | null; best: number | null }) {
  if (value === null) return <Td right muted>—</Td>;
  const isBest = best !== null && value === best;
  return (
    <td
      className={`px-3 py-2 text-right tabular-nums ${
        isBest
          ? "font-semibold text-green-700 dark:text-green-400"
          : "text-zinc-700 dark:text-zinc-300"
      }`}
    >
      {value.toFixed(3)}
    </td>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

function Td({
  children,
  right,
  muted,
}: {
  children: React.ReactNode;
  right?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${right ? "text-right" : ""} ${
        muted ? "text-zinc-500 dark:text-zinc-400" : ""
      }`}
    >
      {children}
    </td>
  );
}
