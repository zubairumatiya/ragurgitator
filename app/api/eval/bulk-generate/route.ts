// ---------------------------------------------------------------------------
// API route: POST /api/eval/bulk-generate
//
// "Bulk actions → Add question → {easy|medium|hard} ×N → Add" on /eval: adds the
// requested difficulties to the active config's mix, then tops every chunk up to
// N questions at each and scores the unscored. Streams progress as NDJSON (one
// EvalEvent per line) so the dashboard reuses the Process-new-chunks progress
// bar. Body: { counts: { easy?: n, medium?: n, hard?: n } }, or the legacy
// { difficulty: 'easy'|'medium'|'hard' } (one question per chunk).
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import {
  bulkAddDifficulties,
  type Difficulty,
  type DifficultyTarget,
  type EvalEvent,
} from "@/lib/rag/eval";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { addDifficulty } from "@/lib/rag/evalSettingsStore";
import { getActiveBatchSavings } from "@/lib/rag/batchStore";
import { isBatchEnabled, providerOfKind } from "@/lib/batch/types";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";

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
  if (targets.length === 0) {
    return Response.json(
      { error: "Pick at least one difficulty to add questions at." },
      { status: 400 },
    );
  }

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
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
          });
          if (!built || built.requests.length === 0) {
            send({ type: "done", generated: 0, scored: 0, recall: null, mrr: null, ndcg: null });
            return;
          }
          const cfg = await getConfig(activeConfig().id);
          const job = await submitBatch({
            kind: "question_generation",
            provider: providerOfKind("question_generation"),
            configId: activeConfig().id,
            configLabel: cfg?.label ?? "—",
            requests: built.requests,
            input: built.input,
            submitMeta: built.submitMeta,
          });
          send({ type: "batch-submitted", jobId: job.id, requestCount: job.requestCount });
          return;
        }

        await bulkAddDifficulties(targets, send, documentIds);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bulk generation failed.";
        send({ type: "error", message });
      }
    }),
  );
}
