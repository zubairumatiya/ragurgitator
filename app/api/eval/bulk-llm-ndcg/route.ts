// API route: POST /api/eval/bulk-llm-ndcg
//
// "Bulk actions → Add LLM nDCG rankings": for every labeled question in scope that
// ALREADY has an aggregate ranking, build the llm_rerank ranking via the same
// builder the per-question panel uses. Questions with no aggregate, and ones whose
// llm_rerank is still cached, are skipped and counted on the stream — this spends
// LLM tokens, so the counts are the run's account of what it did NOT pay for.
//
// Nothing is promoted to ground truth: the rankings land as comparison candidates.
// Streams progress as NDJSON. Body: { documentIds? }.
import { streamError } from "@/lib/http/missingKeyServer";
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import type { EvalEvent } from "@/lib/rag/eval";
import { bulkBuildLlmRankings } from "@/lib/rag/ranking";
import { assertDemoAllows } from "@/lib/demo/policy";

const Body = z.object({
  // Bulk-actions document scope: rank only these documents' questions
  // (absent = the whole corpus).
  documentIds: z
    .array(z.uuid({ error: "`documentIds` must contain uuids." }))
    .optional(),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;
  const { documentIds } = body.data;

  return withRequestConfig(request, async () => {
    await assertDemoAllows("llmRank");
    return ndjsonStream<EvalEvent>(async (send, shouldStop) => {
      try {
        await bulkBuildLlmRankings(send, documentIds, shouldStop);
      } catch (err) {
        send(streamError(err, "Bulk LLM nDCG ranking failed."));
      }
    });
  });
}
