// Corpus clusters (was app/clusters/page.tsx) — scoped to the active config. The
// tab bar, banner, and sub-nav live in the layout; this renders just its content.
import { ClusterDashboard } from "@/app/components/ClusterDashboard";

export default function ClustersPage() {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Corpus clusters
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          k-means over the corpus embeddings — each run makes 3 candidates, so
          keep the ones you like.{" "}
          <strong className="font-medium text-zinc-700 dark:text-zinc-300">
            Cohesion
          </strong>{" "}
          (0–1) measures how tight each bucket is;{" "}
          <strong className="font-medium text-zinc-700 dark:text-zinc-300">
            silhouette
          </strong>{" "}
          (−1 to 1) also rewards buckets being well separated. Higher is better for
          both, but use silhouette to compare different k.
        </p>
      </header>

      <ClusterDashboard />
    </>
  );
}
