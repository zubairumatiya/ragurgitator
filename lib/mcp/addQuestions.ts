// THE `add_questions` TOOL PAYLOAD — the first MCP tool that writes.
//
// It exists to decouple corpus size from LLM spend: eval questions written by the
// agent already in the conversation cost nothing, where the in-app generator bills
// a `question_gen` call per chunk. On a ~190-chunk corpus that is the difference
// between a few dollars and zero.
//
// TWO GATES, IN ORDER. The bearer token proves WHO (the client_id check in
// mcpClaims.ts); the write grant proves the user said YES to this client writing,
// within the last hour (0060). A valid token alone gets you nothing here — that
// separation is the entire point of the grant table, and the reason a denial names
// the approval URL rather than returning a bare refusal.
//
// BATCHED, AND PARTIALLY FAILABLE. 390 questions in single calls would be 390 round
// trips, so the tool takes a list — and answers per item. One stale chunk id in a
// batch of fifty must not discard the forty-nine good questions, because the model
// would then rewrite all fifty, and the second attempt would hit the same bad id.
//
// PROVENANCE IS `generated`, NOT `manual`. A human did not write these; an agent
// did, and generator_model records which. If this eval is ever shown to anyone,
// "who wrote these questions" should be answerable from the database rather than
// from memory.
import "server-only";

import { z } from "zod";

import { hasCapability } from "@/lib/mcp/writeGrant";
import { approvalUrl, settleBatch, writeDeniedMessage } from "@/lib/mcp/toolPolicy";
import { withToolConfig } from "@/lib/mcp/toolScope";
import { siteUrl } from "@/lib/mcp/metadata";
import { insertQuestionWithLabel, resolveChunksForLabeling } from "@/lib/rag/evalStore";

// The value stored in eval_questions.generator_model. One fixed string rather than
// the calling client's name: the interesting fact is "an agent authored this", and
// a per-client value would fragment the same provenance across however many MCP
// clients the account ever connects.
export const GENERATOR_MODEL = "claude-code";

// The same three levels the in-app generator uses (lib/rag/eval.ts Difficulty), so
// a question written here means what it would have meant had the app made the call
// — which matters because difficulty is what the holdout split stratifies on.
export const QuestionInput = z.object({
  chunkId: z.string().describe("From list_chunks. The chunk the answer must come from."),
  question: z.string().min(1),
  difficulty: z
    .enum(["easy", "medium", "hard"])
    .describe(
      "easy: direct and factual, may reuse the passage's terms. " +
        "medium: rephrased entirely in your own words. " +
        "hard: indirect or abstracted, sharing no distinctive vocabulary. " +
        "At every level the answer must be found UNIQUELY in this chunk.",
    ),
  expectedAnswer: z
    .string()
    .optional()
    .describe("Short answer drawn from the passage. Optional but worth recording."),
});

export const AddQuestionsOutputSchema = z.object({
  added: z.number(),
  failed: z.number(),
  results: z.array(
    z.object({
      chunkId: z.string(),
      ok: z.boolean(),
      questionId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

export type AddQuestionsPayload = z.infer<typeof AddQuestionsOutputSchema>;

export type AddQuestionsResult =
  | { ok: true; payload: AddQuestionsPayload }
  | { ok: false; error: string };

export async function addQuestions(args: {
  configId: string;
  questions: z.infer<typeof QuestionInput>[];
  userId: string;
  clientId: string;
  tokenExpSeconds?: number;
}): Promise<AddQuestionsResult> {
  const allowed = await hasCapability(args.userId, args.clientId, "questions_write");
  if (!allowed) {
    return {
      ok: false,
      error: writeDeniedMessage(
        "questions_write",
        approvalUrl(siteUrl(), args.clientId, ["questions_write"], args.tokenExpSeconds),
      ),
    };
  }

  const scoped = await withToolConfig(args.configId, async () => {
    // One resolution query for the whole batch, then settleBatch decides each
    // item's fate against it — see toolPolicy.ts for why a bad id is an item
    // failure rather than a batch failure.
    const resolved = await resolveChunksForLabeling(args.questions.map((q) => q.chunkId));

    return settleBatch(
      args.questions,
      (chunkId) => resolved.has(chunkId),
      (q) =>
        insertQuestionWithLabel({
          documentId: resolved.get(q.chunkId)!.documentId,
          documentEmbeddingId: resolved.get(q.chunkId)!.documentEmbeddingId,
          sourceChunkId: q.chunkId,
          question: q.question,
          expectedAnswer: q.expectedAnswer ?? null,
          source: "generated",
          generatorModel: GENERATOR_MODEL,
          difficulty: q.difficulty,
        }),
    );
  });
  if (!scoped.ok) return scoped;

  const results = scoped.value;
  return {
    ok: true,
    payload: {
      added: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    },
  };
}
