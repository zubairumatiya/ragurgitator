// ---------------------------------------------------------------------------
// UI: "this cluster preset needs re-fitting" flag.
//
// Ingesting a document tops its chunks into every saved preset by nearest
// EXISTING centroid (clusterStore.topUpSavedRuns) so their questions are
// gradeable right away. The centroids are never recomputed — that would move
// the pools out from under already-graded questions — so each top-up leaves the
// centroid a little further from the true center of its bucket. This badge is
// where that debt comes due: past config.clusterDriftThreshold the preset is
// describing too little of the corpus to trust, and only re-running clustering
// restores a real fit.
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
        "of their buckets — pools built from this preset get looser as the gap grows. " +
        "Re-run clustering and save a new preset to re-fit."
      }
    >
      <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
        ↻ {pct}% drift
      </span>
    </Tooltip>
  );
}
