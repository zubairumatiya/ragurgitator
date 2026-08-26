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
import { autotuneStep } from "@/lib/jobs/steps/autotune";
import { probeReplayStep } from "@/lib/jobs/steps/probeReplay";
import { getActiveCriteria } from "@/lib/rag/evalSettingsStore";

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
  // The conversion this file used to describe as outstanding is done — see
  // lib/jobs/steps/autotune.ts for what its cursor had to carry, and
  // docs/autotune-slicing-plan.md for the run that made the case.
  //
  // One mode still cannot go to the background: apply='choose' exists to collect
  // per-chunk decisions from a panel that is reading the stream, and in the
  // background nothing is. The launch and estimate routes refuse it by name rather
  // than letting a job run that would silently apply nothing.
  autotune: autotuneStep,
  probe_replay: probeReplayStep,
};

export function stepFor(kind: JobKind): AnyStep | null {
  return STEPS[kind] ?? null;
}

export function isWired(kind: JobKind): boolean {
  return kind in STEPS;
}

// Why this kind cannot go to the background RIGHT NOW, under the active config —
// null when it can. Separate from isWired because this one depends on settings
// rather than on whether the conversion has been written.
//
// autotune's apply='choose' is the only case: its whole point is a panel that
// collects a per-chunk decision from the event stream, and in background mode
// nothing is reading that stream. A job would run, find several passing families
// per chunk, apply none of them, and email the user that it succeeded.
//
// It carries a `fix` because this blocker is a SETTING, not a limitation: the user
// can have the background run by giving up the per-chunk choice, and making them
// leave the dialog to find that switch in Eval Settings is a worse version of the
// same decision. Persisting pending choices to a table remains the answer that
// would remove the trade-off entirely.
export type BackgroundBlock = {
  reason: string;
  // A settings change that would unblock this kind, offered as a button in the
  // dialog. `fix` absent = nothing the user can do from here.
  fix?: {
    // Handled by name in BackgroundOfferDialog, which owns the PATCH. An id rather
    // than a patch body so the server is not shipping the client a request to
    // send back to the server.
    id: "autotune_auto_best";
    label: string;
    note: string;
  };
};

export async function backgroundBlocker(kind: JobKind): Promise<BackgroundBlock | null> {
  if (kind !== "autotune") return null;
  const criteria = await getActiveCriteria();
  if (criteria.autotune.apply !== "choose") return null;
  return {
    reason:
      "Autotune can't run in the background while Apply is set to \u201cyou choose\u201d: " +
      "picking between fixes needs this tab open.",
    fix: {
      id: "autotune_auto_best",
      label: "Switch to auto-best & run in the background",
      note:
        "Switches Apply to auto-best for this config \u2014 the highest-scoring passing " +
        "fix is applied automatically, with no pause to choose.",
    },
  };
}
