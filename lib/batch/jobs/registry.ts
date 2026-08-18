// JOB REGISTRY — the seam between the generic batch machinery and each job's
// specifics. A handler is two halves:
//
//   build(scope)  — turn a launch request into provider requests + the `input`
//                   payload apply will need later. Runs inside the launching
//                   config's withConfig scope. Returns null = nothing to do.
//   apply(input,  — write provider results back into the app. Runs later (during a
//         results)  poll), inside the job's config scope. MUST be idempotent: a
//                   re-poll or retry can call it again on the same results.
//
// Only kinds with a handler here can be submitted; the others are recognized
// everywhere else (settings/preference/status) but POST /api/batch/submit guards
// them with a 501 until their handler lands.
import type { BatchProvider, BatchRequest, BatchResultRow, JobKind } from "@/lib/batch/types";
import type { SubmitMeta } from "@/lib/batch/providers";
import { questionGenerationHandler } from "@/lib/batch/jobs/questionGeneration";
import { clusterLabelingHandler } from "@/lib/batch/jobs/clusterLabeling";
import { ingestEmbeddingHandler } from "@/lib/batch/jobs/ingestEmbedding";
import { pairGenerationHandler } from "@/lib/batch/jobs/pairGeneration";
import { pairScreenHandler } from "@/lib/batch/jobs/pairScreen";

export type BuiltBatch = {
  requests: BatchRequest[];
  // Which batch API these requests go to. BUILD-TIME, not per-kind: the LLM jobs
  // route by the provider of the model they just put in the requests, so a config
  // on a gpt-* model batches through OpenAI and one on claude-* through Anthropic.
  // It lives here rather than as a static field on the handler because the handler
  // is the only thing that knows which model it used — cache_pair_generation, for
  // one, runs on its own configured generateModel rather than the config's
  // llmModel — and a second, hand-maintained copy of that answer is exactly the
  // kind of disagreement that ends up billing the wrong provider's key.
  provider: BatchProvider;
  // Persisted on the job row (jsonb) and handed back to apply verbatim.
  input: unknown;
  // Batch-level params for Voyage (model/dims); {} for the LLM providers, which
  // both carry the model per request.
  submitMeta: SubmitMeta;
};

// A FOLLOW-ON batch a job wants submitted once its own results are applied.
// Only cache_pair_generation has one today: the pairs it writes need a judge
// screen, and one sequential judge call per pair inside the apply step is the
// thing the batch API exists to avoid — so the screen is another batch, not a
// loop. Returning the KIND rather than submitting here keeps handlers free of
// the orchestrator (which imports this file).
export type ChainedBatch = { kind: JobKind; scope: unknown };

export interface JobHandler {
  // SINGLETON kinds refuse a second submission while one is still open. Set it
  // when a build selects its own work from the database rather than from the
  // caller's scope: the first batch has not written its results back yet, so a
  // second build finds the very same rows and pays for them twice. That is
  // exactly cache_pair_screen (every unjudged pair) and exactly not
  // question_generation (whatever the caller asked for).
  singleton?: boolean;
  build(scope: unknown): Promise<BuiltBatch | null>;
  apply(input: unknown, results: BatchResultRow[]): Promise<number>;
  // Optional. Runs after apply() succeeds, in the same config scope. Returning
  // null (or omitting it) chains nothing.
  chain?(input: unknown, applied: number): Promise<ChainedBatch | null>;
}

const HANDLERS: Partial<Record<JobKind, JobHandler>> = {
  question_generation: questionGenerationHandler,
  cluster_labeling: clusterLabelingHandler,
  ingest_embedding: ingestEmbeddingHandler,
  cache_pair_generation: pairGenerationHandler,
  cache_pair_screen: pairScreenHandler,
  // ndcg_ranking — recognized, submit guarded. Not just an unwritten handler:
  // there is no bulk LLM ranking to batch. The bulk nDCG flow builds the
  // cross-model AGGREGATE truth (embeddings, no LLM), and llm_pool/llm_rerank
  // are per-question and interactive. See the plan doc.
};

export function handlerFor(kind: JobKind): JobHandler | null {
  return HANDLERS[kind] ?? null;
}

export function isWired(kind: JobKind): boolean {
  return kind in HANDLERS;
}
