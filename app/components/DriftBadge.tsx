// ---------------------------------------------------------------------------
// UI: "this cluster preset needs re-fitting" flag.
//
// Ingesting a document tops its chunks into every saved preset by nearest
// EXISTING centroid (clusterStore.topUpSavedRuns), so a preset keeps covering
// the corpus without a re-run. But the centroids stay where the original fit put
// them: each top-up drops members around a center that was never recomputed,
// leaving it a little further from the true middle of its bucket. This badge is
// where that debt comes due: past config.clusterDriftThreshold the preset no
// longer describes the corpus well enough to read as an observation — its
// cohesion/silhouette numbers describe the old fit, not what's in the buckets
// now — and only re-running clustering restores a real fit.
//
// Renders nothing below the threshold: under it, top-up is working as intended
// and there's nothing to act on.
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { Tooltip } from "@/app/components/Tooltip";

export function DriftBadge({
  toppedUpCount,
  driftRatio,
  chunkCount,
  align = "center",
}: {
  toppedUpCount: number;
  driftRatio: number;
  chunkCount: number; // members from the original fit
  align?: "center" | "left" | "right";
}) {
  if (driftRatio < config.clusterDriftThreshold) return null;
  const pct = Math.round(driftRatio * 100);
  return (
    <Tooltip
      align={align}
      text={
        `${toppedUpCount} of ${chunkCount + toppedUpCount} chunks (${pct}%) were added ` +
        "after this preset was fit, assigned to the nearest existing centroid. " +
        "The centroids were never recomputed, so they no longer sit at the center " +
        "of their buckets — the further they drift, the less this preset's shape " +
        "and its cohesion/silhouette scores say about the corpus you have now. " +
        "Re-run clustering and save a new preset to re-fit."
      }
    >
      <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
        ↻ {pct}% drift
      </span>
    </Tooltip>
  );
}
