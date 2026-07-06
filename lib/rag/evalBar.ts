// ---------------------------------------------------------------------------
// The D1 "below the bar" test, shared by client and server: a question fails a
// metric when that metric is enabled, has a min-rate, and the question's fresh
// per-question value is under it (recall is binary per question, so any
// positive recall min-rate means "must be a hit"; nDCG is graded). Pure — no
// imports from server-only modules, so client components can use it for the
// autotune preview count and the per-row "Ignore in rates" affordance. The
// server-side mirror with full typing lives in lib/rag/autotune.failingMetrics;
// keep the two rules in sync.
// ---------------------------------------------------------------------------
import type { EvalCriteria } from "@/lib/rag/evalSettingsStore";

export type BarQuestion = {
  hit: boolean | null;
  stale: boolean;
  ndcg: number | null;
  ignored?: boolean;
};

// Does this question fail at least one targeted metric? Ignored questions never
// fail the bar (they're excluded from rates and autotune targeting, §7).
export function failsBar(q: BarQuestion, criteria: EvalCriteria): boolean {
  if (q.ignored || q.hit === null || q.stale) return false;
  const { recall, ndcg } = criteria;
  if (recall.enabled && recall.minRate !== null && recall.minRate > 0 && q.hit === false) {
    return true;
  }
  return ndcg.enabled && ndcg.minRate !== null && q.ndcg !== null && q.ndcg < ndcg.minRate;
}
