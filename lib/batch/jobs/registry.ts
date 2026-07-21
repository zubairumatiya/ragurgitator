// ---------------------------------------------------------------------------
// JOB REGISTRY — the seam between the generic batch machinery and each job's
// specifics. A handler is two halves:
//
//   build(scope)  — turn a launch request into provider requests + the `input`
//                   payload apply will need later. Runs inside the launching
//                   config's withConfig scope. Returns null = nothing to do.
//   apply(input,  — write provider results back into the app. Runs later (during
//         results)  a poll), inside the job's config scope. MUST be idempotent:
//                   a re-poll or retry can call it again on the same results.
//
// Only kinds with a handler here can be submitted; the others are recognized
// everywhere else (settings/preference/status) but POST /api/batch/submit
// guards them with a 501 until their handler lands (see the plan doc's phasing).
// ---------------------------------------------------------------------------
import type { BatchProvider, BatchRequest, BatchResultRow, JobKind } from "@/lib/batch/types";
import type { SubmitMeta } from "@/lib/batch/providers";
import { questionGenerationHandler } from "@/lib/batch/jobs/questionGeneration";
import { clusterLabelingHandler } from "@/lib/batch/jobs/clusterLabeling";

export type BuiltBatch = {
  requests: BatchRequest[];
  // Persisted on the job row (jsonb) and handed back to apply verbatim.
  input: unknown;
  // Batch-level params for Voyage (model/dims); {} for Anthropic.
  submitMeta: SubmitMeta;
};

export interface JobHandler {
  provider: BatchProvider;
  build(scope: unknown): Promise<BuiltBatch | null>;
  apply(input: unknown, results: BatchResultRow[]): Promise<number>;
}

const HANDLERS: Partial<Record<JobKind, JobHandler>> = {
  question_generation: questionGenerationHandler,
  cluster_labeling: clusterLabelingHandler,
  // ndcg_ranking, ingest_embedding — recognized, submit guarded (plan doc phasing).
};

export function handlerFor(kind: JobKind): JobHandler | null {
  return HANDLERS[kind] ?? null;
}

export function isWired(kind: JobKind): boolean {
  return kind in HANDLERS;
}
