// ---------------------------------------------------------------------------
// API route: POST /api/eval/bulk-llm-ndcg
//
// "Bulk actions → Add LLM nDCG rankings" on /eval: for every labeled question in
// scope that ALREADY has an aggregate ranking, build the llm_rerank ranking (the
// aggregate's top-k re-ordered by the LLM) via the same builder the per-question
// panel uses. Questions with no aggregate, and ones whose llm_rerank is still
// cached/fresh, are skipped and counted on the stream — this spends LLM tokens,
// so the counts are the run's account of what it did NOT pay for.
//
// Nothing is promoted to ground truth: the rankings land as comparison
// candidates, exactly as a per-question "Re-rank top-k" would. Streams progress
// as NDJSON (one EvalEvent per line). Body: { documentIds? }.
// ---------------------------------------------------------------------------
import { streamError } from "@/lib/http/missingKeyServer";
import { z } from "zod";
import { parseBody } from "@/lib/http/body";
import { withRequestConfig } from "@/lib/http/configScope";
import { ndjsonStream } from "@/lib/http/ndjson";
import type { EvalEvent } from "@/lib/rag/eval";
import { bulkBuildLlmRankings } from "@/lib/rag/ranking";

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

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await bulkBuildLlmRankings(send, documentIds);
      } catch (err) {
        send(streamError(err, "Bulk LLM nDCG ranking failed."));
      }
    }),
  );
}
