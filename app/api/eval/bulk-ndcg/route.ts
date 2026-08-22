// API route: POST /api/eval/bulk-ndcg
//
// "Bulk actions → Add nDCG rankings" on /eval: for every labeled question in
// scope without a ground-truth ranking, build the cross-model aggregate ranking
// (the same builder as the per-question panel — its candidate pool comes from a
// vector query over the corpus), promote it to ground truth, and score the
// still-unscored. Streams progress as NDJSON (one EvalEvent per line) for the
// dashboard's progress bar. Body: { documentIds?, rebuild? }.
//
// The work is lib/jobs/steps/bulkNdcg.ts, driven here to completion. The same step
// also runs as a background job (POST /api/jobs) when the estimate says it will
// outlast the user's patience — one implementation, two drivers.
import { streamError } from "@/lib/http/missingKeyServer";
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import { runStepStreamed } from "@/lib/jobs/stream";
import { bulkNdcgStep } from "@/lib/jobs/steps/bulkNdcg";
import type { EvalEvent } from "@/lib/rag/eval";
import { getSummary } from "@/lib/rag/evalStore";
import { assertDemoAllows } from "@/lib/demo/policy";

const Body = z.object({
  // Bulk-actions document scope: grade only these documents' questions
  // (absent = the whole corpus).
  documentIds: z
    .array(z.uuid({ error: "`documentIds` must contain uuids." }))
    .optional(),
  // When true, ALSO refresh questions whose ground truth is the aggregate (their
  // ideals predate later-ingested documents) and re-score them.
  rebuild: z.boolean().optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const { documentIds, rebuild } = body.data;

  return withRequestConfig(request, async () => {
    await assertDemoAllows("rescore");
    return ndjsonStream<EvalEvent>(async (send, shouldStop) => {
      try {
        const run = await runStepStreamed(
          "bulk_ndcg",
          bulkNdcgStep,
          { documentIds, rebuild },
          send,
          shouldStop,
        );
        // One read for the closing line, whether or not finalize ran: finalize's
        // return value is the same numbers, and a cancelled run has to get them
        // from somewhere. `scored` is the config's total; this run's own
        // contribution is `graded`.
        const summary = await getSummary();
        send({
          type: "done",
          cancelled: run.cancelled,
          generated: 0,
          graded: run.doneUnits,
          scored: summary.scored,
          recall: summary.recall,
          mrr: summary.mrr,
          ndcg: summary.ndcg,
        });
      } catch (err) {
        send(streamError(err, "Bulk nDCG grading failed."));
      }
    });
  });
}
