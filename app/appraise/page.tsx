// Appraise — the pinned, cross-config view (a peer of the config tabs, not a
// config itself; see docs/multi-config-plan.md §6). STUB for Phase 2: placeholder
// copy only. The real cross-config statistical analysis + comparison is deferred
// (Phase 4 in the §8 phase table). Intentionally standalone — it sits outside the
// /c/[configId] segment, so it doesn't carry the per-config banner/sub-nav.
import Link from "next/link";

export default function AppraisePage() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-16">
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
            TODO: statistical analysis and comparison across configs.
          </p>
        </header>

        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Cross-config comparison lands in a later phase. For now, open a config tab
          to run retrieval, evals, and clustering.
        </div>
      </main>
    </div>
  );
}
