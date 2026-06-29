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

const DIFFICULTIES = ["easy", "medium", "hard"] as const satisfies readonly Difficulty[];

const Body = z.object({
  difficulty: z.enum(DIFFICULTIES, {
    error: "Provide a `difficulty` of 'easy', 'medium', or 'hard'.",
  }),
});

export async function POST(request: Request) {
  const body = await parseBody(request, Body);
  if (body.response) return body.response;

  return withRequestConfig(request, async () =>
    ndjsonStream<EvalEvent>(async (send) => {
      try {
        await bulkAddDifficulty(body.data.difficulty, send);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bulk generation failed.";
        send({ type: "error", message });
      }
    }),
  );
}
