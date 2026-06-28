// Retrieval evals (was app/eval/page.tsx) — scoped to the active config. The tab
// bar, banner, and sub-nav live in the layout; this page renders just its content.
import { EvalDashboard } from "@/app/components/EvalDashboard";

export default function EvalPage() {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Retrieval evals
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Recall@k over synthetic questions, one per chunk. Processing is
          incremental — only new or edited questions are scored.
        </p>
      </header>

      <EvalDashboard />
    </>
  );
}
