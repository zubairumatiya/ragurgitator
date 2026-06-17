import { EvalDashboard } from "@/app/components/EvalDashboard";
import { Nav } from "@/app/components/Nav";

export default function EvalPage() {
  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-8 py-16 px-8">
        <header className="flex flex-col gap-4">
          <Nav />
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              Retrieval evals
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Recall@k over synthetic questions, one per chunk. Processing is
              incremental — only new or edited questions are scored.
            </p>
          </div>
        </header>

        <EvalDashboard />
      </main>
    </div>
  );
}
