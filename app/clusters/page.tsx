import Link from "next/link";

import { ClusterDashboard } from "@/app/components/ClusterDashboard";

export default function ClustersPage() {
  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-8 py-16 px-8">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <Link href="/" className="text-sm text-zinc-500 hover:underline">
              ← Back to playground
            </Link>
            <Link href="/eval" className="text-sm text-zinc-500 hover:underline">
              Evals →
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Corpus clusters
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            k-means over the corpus embeddings. Each run makes 3 candidates (random
            restarts) — keep the ones you like. Per-bucket tightness is cohesion; the
            run-level silhouette stays comparable across different k.
          </p>
        </header>

        <ClusterDashboard />
      </main>
    </div>
  );
}
