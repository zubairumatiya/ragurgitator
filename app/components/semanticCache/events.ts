// ---------------------------------------------------------------------------
// Window events wiring the Appraise → Semantic caching panels together. They're
// siblings under a Server Component page with no shared parent state, so they
// talk over the window rather than through props.
//
// Only ONE panel writes thresholds (ApplyThresholdPanel, on the Collision floor
// heading row). The calibration panels — collision floor itself and the shadow
// judge lower down — compute recommendations and broadcast them; nothing they
// do is live until the apply panel is used.
//
// The wiring doesn't care about panel order: recommendations are emitted from
// fetch callbacks, so every listener has long since mounted.
// ---------------------------------------------------------------------------

// A threshold was written. Display panels re-pull.
export const SC_CHANGED = "sc:thresholds-changed";

// A calibration panel produced a recommendation. The apply panel prefills from
// it, carrying the provenance through so the value that lands in
// semantic_cache_thresholds records where it came from rather than "manual".
export const SC_RECOMMEND = "sc:threshold-recommended";

export type ThresholdRecommendation = {
  value: number;
  space: string;
  // Short human label for the chip ("collision floor", "shadow judge").
  origin: string;
  // Written verbatim to semantic_cache_thresholds.notes on a space apply.
  notes: string;
  sampleSize: number | null;
};

// Recommendations are rounded to 4 decimals before they leave their panel.
//
// Nothing downstream can honour more. semantic_cache_thresholds.threshold is
// `real` (float4, ~7 significant digits), and the cached query vectors sim is
// computed from are `real[]` too — so 0.943 already lands at 0.94300002 in the
// table, and sim itself carries error near 1e-6. Four decimals sits an order of
// magnitude above that noise floor and well below collisionMargin (0.01), the
// granularity calibration actually reasons at.
//
// It also keeps float arithmetic out of the input box: a collision floor of
// 0.933 + 0.01 is 0.9430000000000001 in float64, and showing THAT as the
// suggested threshold would be alarming for no reason.
export function emitRecommendation(rec: ThresholdRecommendation): void {
  const value = Math.round(rec.value * 1e4) / 1e4;
  window.dispatchEvent(new CustomEvent(SC_RECOMMEND, { detail: { ...rec, value } }));
}

// Subscribe to recommendations; returns the unsubscribe for an effect cleanup.
export function onRecommendation(
  handler: (rec: ThresholdRecommendation) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<ThresholdRecommendation>).detail);
  window.addEventListener(SC_RECOMMEND, listener);
  return () => window.removeEventListener(SC_RECOMMEND, listener);
}
