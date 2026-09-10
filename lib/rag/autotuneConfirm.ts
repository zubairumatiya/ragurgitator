// THE CONFIRM RULE, as a pure function — docs/demo-voyage-tuning-plan.md §3.5.
//
// applyAutotuneCandidate (lib/rag/autotune.ts) keeps an override only if the
// chunk's failing (question, metric) set shrank with no new failure, or — under
// keep-best — no new failure and the failing pairs' summed metric rose. The
// replayed autotune a guest runs (lib/jobs/steps/autotune.ts runReplay) now
// confirms a banked winner against the guest's OWN questions by the same rule.
// One function, imported by both, so the two cannot drift: a search that keeps
// what the confirm would revert is the defect the plan's §0 measured.
//
// No database and no `server-only` here, so a unit test can reach it.

export type ConfirmMode = "clear" | "improve";

export type ConfirmVerdict = {
  keep: boolean;
  // Why not, when not; which of the two keep clauses fired, when kept.
  reason: "new-failure" | "no-progress" | "shrank" | "rose";
};

// `before` and `after` are the failing (question:metric) pair sets under the
// same retrieval state, fresh on both sides; `beforeSum` / `afterSum` are the
// BEFORE set's metric values summed under each state, which is what "the
// failing pairs' values rose" means — the pairs that were failing, not whatever
// is failing now.
export function confirmVerdict(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  beforeSum: number,
  afterSum: number,
  mode: ConfirmMode,
): ConfirmVerdict {
  for (const p of after) {
    if (!before.has(p)) return { keep: false, reason: "new-failure" };
  }
  if (after.size < before.size) return { keep: true, reason: "shrank" };
  if (mode === "improve" && afterSum > beforeSum + 1e-9) return { keep: true, reason: "rose" };
  return { keep: false, reason: "no-progress" };
}
