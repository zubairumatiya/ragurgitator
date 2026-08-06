// ---------------------------------------------------------------------------
// API route: POST /api/eval/bulk-ndcg
//
// "Bulk actions → Add nDCG rankings" on /eval: for every labeled question in
// scope without a ground-truth ranking, build the cross-model aggregate ranking
// (the same builder as the per-question panel — its candidate pool comes from a
// vector query over the corpus), promote it to ground truth, and score the
// still-unscored. Streams progress as NDJSON (one EvalEvent per line) for the
// dashboard's progress bar. Body: { documentIds?, rebuild? }.
// ---------------------------------------------------------------------------
import { streamError } from "@/lib/http/missingKeyServer";
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import type { EvalEvent } from "@/lib/rag/eval";
import { bulkBuildRankings } from "@/lib/rag/ranking";

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

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await bulkBuildRankings(send, documentIds, rebuild);
      } catch (err) {
        send(streamError(err, "Bulk nDCG grading failed."));
      }
    }),
  );
}
