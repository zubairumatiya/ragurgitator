// The seam between the generic slice runner and each bulk action's specifics —
// the same shape lib/batch/jobs/registry.ts uses for provider batches, and for the
// same reason: the runner should know how to advance a job without knowing what
// any job does.
//
// A kind with no entry here is recognized everywhere else (types, labels, the
// panel) but cannot be launched. That is deliberate while the conversions land one
// at a time: launchJob throws by name rather than creating a row nothing can ever
// advance.
import type { JobStep } from "@/lib/jobs/types";
import { type JobKind } from "@/lib/jobs/types";
import { rescoreStep } from "@/lib/jobs/steps/rescore";
import { bulkNdcgStep } from "@/lib/jobs/steps/bulkNdcg";

// Each step is precisely typed where it is defined; the registry is the one place
// the scope, cursor and result types are necessarily heterogeneous. `never` for the
// scope is what makes a map of differently-typed steps assignable — method syntax
// in JobStep is bivariant, so a step that wants a RescoreScope still fits — while
// the cursor has to be `unknown` because it appears as an output too (plan returns
// one). The runner passes both through as opaque values regardless.
type AnyStep = JobStep<never, unknown, unknown, unknown>;

const STEPS: Partial<Record<JobKind, AnyStep>> = {
  rescore: rescoreStep,
  bulk_ndcg: bulkNdcgStep,
  // autotune — NOT WIRED, and not because it is unimportant: it is the longest job
  // here and the one that most wants a background. It is unwired because its
  // conversion is a real refactor rather than a wrapper, and half of one would be
  // worse than none.
  //
  // What it needs, from having traced it: runAutotune recomputes its targets from
  // the CURRENT summary (failing questions per chunk), so the work is largely
  // self-eliminating and a resumed run naturally picks up the remaining gaps. But
  // three things are run-scoped rather than derivable, and would have to move into
  // the cursor: the run-start retrieval fingerprint and override set (the run-end
  // dirty-set re-score, rescoreAffectedQuestions, is defined against them), and the
  // chunks this run already tried and could not improve — without those, a resumed
  // run would re-attempt the same hopeless chunk every slice. Its emit stream also
  // feeds an interactive panel that collects pending choices, so the events have to
  // survive slicing intact.
  //
  // Until then autotune runs as it always has: streamed, with the tab open.
};

export function stepFor(kind: JobKind): AnyStep | null {
  return STEPS[kind] ?? null;
}

export function isWired(kind: JobKind): boolean {
  return kind in STEPS;
}
