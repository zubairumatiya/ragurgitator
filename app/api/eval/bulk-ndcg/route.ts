// ---------------------------------------------------------------------------
// API route: POST /api/eval/bulk-ndcg
//
// "Bulk actions → Add nDCG rankings → {preset}" on /eval: for every labeled
// question in scope without a ground-truth ranking, build the cross-model
// aggregate ranking from the chosen cluster preset (the same builder as the
// per-question panel), promote it to ground truth, and score the still-unscored.
// Streams progress as NDJSON (one EvalEvent per line) for the dashboard's
// progress bar. Body: { clusterRunId, documentIds? }.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import type { EvalEvent } from "@/lib/rag/eval";
import { bulkBuildRankings } from "@/lib/rag/ranking";

const Body = z.object({
  clusterRunId: z.string({ error: "`clusterRunId` is required." }).min(1, {
    error: "`clusterRunId` is required.",
  }),
  // Bulk-actions document scope: grade only these documents' questions
  // (absent = the whole corpus).
  documentIds: z
    .array(z.uuid({ error: "`documentIds` must contain uuids." }))
    .optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const { clusterRunId, documentIds } = body.data;

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await bulkBuildRankings(clusterRunId, send, documentIds);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bulk nDCG grading failed.";
        send({ type: "error", message });
      }
    }),
  );
}
