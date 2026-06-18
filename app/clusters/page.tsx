import { ClusterDashboard } from "@/app/components/ClusterDashboard";
import { Nav } from "@/app/components/Nav";

export default function ClustersPage() {
  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col gap-8 py-16 px-8">
        <header className="flex flex-col gap-4">
          <Nav />
          <div className="flex flex-col gap-2">
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
          </div>
        </header>

        <ClusterDashboard />
      </main>
    </div>
  );
}
