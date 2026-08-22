// API route: POST /api/eval/bulk-generate
//
// "Bulk actions → Add question → {easy|medium|hard} ×N → Add" on /eval: adds the
// requested difficulties to the active config's mix, then adds N questions at each
// to every chunk in scope (or, with `topUp`, tops each chunk up TO N) and scores the
// unscored. With `cachedOnly`, every chunk in scope is instead topped up from
// question_cache — any difficulty, no counts, no generation, no cost.
//
// Streams progress as NDJSON. Body: { counts: { easy?, medium?, hard? } }, or the
// legacy { difficulty } (one question per chunk).
import { streamError } from "@/lib/http/missingKeyServer";
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import {
  bulkAddCachedQuestions,
  bulkAddDifficulties,
  type Difficulty,
  type DifficultyTarget,
  type EvalEvent,
} from "@/lib/rag/eval";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { addDifficulty } from "@/lib/rag/evalSettingsStore";
import { getActiveBatchSavings } from "@/lib/rag/batchStore";
import { isBatchEnabled } from "@/lib/batch/types";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";
import { assertDemoAllows } from "@/lib/demo/policy";

const DIFFICULTIES = ["easy", "medium", "hard"] as const satisfies readonly Difficulty[];

// Questions per chunk at each difficulty — the click counts from the panel's
// badges. Capped so a stray click can't queue a corpus-sized bill.
const MAX_PER_DIFFICULTY = 10;
const Count = z
  .number()
  .int()
  .min(1)
  .max(MAX_PER_DIFFICULTY, {
    error: `At most ${MAX_PER_DIFFICULTY} questions per difficulty per run.`,
  });

const Body = z.object({
  counts: z
    .object({ easy: Count.optional(), medium: Count.optional(), hard: Count.optional() })
    .optional(),
  // Legacy single-difficulty form (one question per chunk).
  difficulty: z.enum(DIFFICULTIES).optional(),
  // Bulk-actions document scope: generate only for these documents' chunks
  // (legacy single `documentId` still accepted; absent = the whole corpus).
  documentId: z.uuid({ error: "`documentId` must be a uuid." }).optional(),
  documentIds: z
    .array(z.uuid({ error: "`documentIds` must contain uuids." }))
    .optional(),
  // "Add cached" rather than "Add": top every chunk in scope up from
  // question_cache instead of generating. Takes no counts and no difficulty — a
  // banked question is free at any difficulty — so it is the one form of this
  // request that is valid with nothing but a document scope. Nothing is generated
  // and nothing is batched, so it ignores the batch preference below entirely.
  cachedOnly: z.boolean().optional(),
  // The panel's "Top up" checkbox. Default false = "add N more to every chunk in
  // scope"; true = the older "fill every chunk TO N", which skips chunks already
  // there. Ignored by `cachedOnly`, which has no counts and no targets.
  topUp: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const documentIds =
    body.data.documentIds ??
    (body.data.documentId ? [body.data.documentId] : undefined);

  // Fixed difficulty order (easy → medium → hard) so the generated questions and
  // the progress bar read in the same order however the badges were clicked.
  const targets: DifficultyTarget[] = body.data.counts
    ? DIFFICULTIES.flatMap((d) => {
        const count = body.data.counts?.[d];
        return count ? [{ difficulty: d, count }] : [];
      })
    : body.data.difficulty
      ? [{ difficulty: body.data.difficulty, count: 1 }]
      : [];
  if (targets.length === 0 && !body.data.cachedOnly) {
    return Response.json(
      { error: "Pick at least one difficulty to add questions at." },
      { status: 400 },
    );
  }

  return withRequestConfig(request, async () => {
    await assertDemoAllows("generate");
    return ndjsonStream<EvalEvent>(async (send, shouldStop) => {
      try {
        if (body.data.cachedOnly) {
          await bulkAddCachedQuestions(send, documentIds, shouldStop);
          return;
        }
        // Savings preference: route question generation through the batch API
        // when this config selected it. Additive — the inline path below is
        // untouched and stays the default (batch is opt-in).
        const savings = await getActiveBatchSavings();
        if (isBatchEnabled(savings, "question_generation")) {
          // Still record the difficulties in the mix so the config reflects the
          // ask, then submit the gaps as a batch instead of generating inline.
          for (const t of targets) await addDifficulty(t.difficulty);
          const handler = handlerFor("question_generation")!;
          const built = await handler.build({
            difficulties: targets.map((t) => t.difficulty),
            counts: targets.map((t) => t.count),
            documentIds,
            topUp: body.data.topUp,
          });
          if (!built || built.requests.length === 0) {
            send({ type: "done", generated: 0, scored: 0, recall: null, mrr: null, ndcg: null });
            return;
          }
          const cfg = await getConfig(activeConfig().id);
          const job = await submitBatch({
            kind: "question_generation",
            provider: built.provider,
            configId: activeConfig().id,
            configLabel: cfg?.label ?? "—",
            requests: built.requests,
            input: built.input,
            submitMeta: built.submitMeta,
          });
          send({ type: "batch-submitted", jobId: job.id, requestCount: job.requestCount });
          return;
        }

        await bulkAddDifficulties(
          targets,
          send,
          documentIds,
          body.data.topUp,
          shouldStop,
        );
      } catch (err) {
        send(streamError(err, "Bulk generation failed."));
      }
    });
  });
}
