// ---------------------------------------------------------------------------
// API route: POST /api/eval/bulk-generate
//
// "Bulk actions → Add question → {easy|medium|hard}" on /eval: adds the
// difficulty to the active config's mix, then generates one question at that
// difficulty for every chunk missing one and scores the unscored. Streams
// progress as NDJSON (one EvalEvent per line) so the dashboard reuses the
// Process-new-chunks progress bar. Body: { difficulty: 'easy'|'medium'|'hard' }.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import { bulkAddDifficulty, type Difficulty, type EvalEvent } from "@/lib/rag/eval";
import { activeConfig } from "@/lib/rag/activeConfig";
import { getConfig } from "@/lib/rag/configStore";
import { addDifficulty } from "@/lib/rag/evalSettingsStore";
import { getActiveBatchSavings } from "@/lib/rag/batchStore";
import { isBatchEnabled, providerOfKind } from "@/lib/batch/types";
import { handlerFor } from "@/lib/batch/jobs/registry";
import { submitBatch } from "@/lib/batch/orchestrator";

const DIFFICULTIES = ["easy", "medium", "hard"] as const satisfies readonly Difficulty[];

const Body = z.object({
  difficulty: z.enum(DIFFICULTIES, {
    error: "Provide a `difficulty` of 'easy', 'medium', or 'hard'.",
  }),
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

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        // Savings preference: route question generation through the batch API
        // when this config selected it. Additive — the inline path below is
        // untouched and stays the default (batch is opt-in).
        const savings = await getActiveBatchSavings();
        if (isBatchEnabled(savings, "question_generation")) {
          // Still record the difficulty in the mix so the config reflects the
          // ask, then submit the gaps as a batch instead of generating inline.
          await addDifficulty(body.data.difficulty);
          const handler = handlerFor("question_generation")!;
          const built = await handler.build({
            difficulties: [body.data.difficulty],
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

        await bulkAddDifficulty(body.data.difficulty, send, documentIds);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bulk generation failed.";
        send({ type: "error", message });
      }
    }),
  );
}
