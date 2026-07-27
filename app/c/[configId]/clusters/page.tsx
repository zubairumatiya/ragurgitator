// Corpus clusters (was app/clusters/page.tsx) — scoped to the active config. The
// tab bar, banner, and sub-nav live in the layout; this renders just its content.
import { ClusterDashboard } from "@/app/components/ClusterDashboard";
import { InfoDot } from "@/app/components/InfoDot";

// The two scores appear on every run card below, so their definitions live here
// rather than as a standing paragraph.
const ABOUT =
  "k-means over the corpus embeddings — each run makes 3 candidates, so keep " +
  "the ones you like.\n\n" +
  "Cohesion (0–1) measures how tight each bucket is; silhouette (−1 to 1) also " +
  "rewards buckets being well separated. Higher is better for both, but use " +
  "silhouette to compare different k.";

export default function ClustersPage() {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Corpus clusters
          <InfoDot text={ABOUT} />
        </h1>
      </header>

      <ClusterDashboard />
    </>
  );
}
