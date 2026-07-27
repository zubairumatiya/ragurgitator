// Retrieval evals (was app/eval/page.tsx) — scoped to the active config. The tab
// bar, banner, and sub-nav live in the layout; this page renders just its content.
import { EvalDashboard } from "@/app/components/EvalDashboard";
import { InfoDot } from "@/app/components/InfoDot";

const ABOUT =
  "Recall@k over synthetic questions, one per chunk.\n\n" +
  "Processing is incremental — only new or edited questions are scored.";

export default function EvalPage() {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Retrieval evals
          <InfoDot text={ABOUT} />
        </h1>
      </header>

      <EvalDashboard />
    </>
  );
}
