// THE `list_chunks` TOOL PAYLOAD — one page of a config's passages.
//
// THIS MOVES A BOUNDARY, so read describeConfig.ts's header alongside it. That tool
// promised "configuration and metrics only — never document or chunk text", and the
// promise was load-bearing: it is what made a read grant an easy yes. This tool
// returns chunk text, so the boundary is now "an approved agent can read the corpus
// it is asked to work on" — a different, larger consent question, stated in the
// server's tool descriptions rather than quietly broken.
//
// WHY IT IS STILL READ-ONLY. Reading chunks writes nothing and needs no write grant.
// The pairing with add_questions is what it's for — an author has to see a passage
// before it can write a question about it — but the two are separately annotated and
// separately gated, so a client that only ever lists is not holding a write key.
//
// PAGING EXISTS FOR THE MODEL, NOT THE DATABASE. ~190 chunks of history prose is
// nothing to Postgres and a great deal of context; the cursor is what keeps a
// question-writing loop to a page at a time. See toolPolicy.ts for the caps.
import "server-only";

import { z } from "zod";

import { chunkPage, nextOffset } from "@/lib/mcp/toolPolicy";
import { withToolConfig } from "@/lib/mcp/toolScope";
import { listChunkPage } from "@/lib/rag/evalStore";

const ChunkShape = z.object({
  chunkId: z.string().describe("Pass this to add_questions as the question's label."),
  documentId: z.string(),
  fileName: z.string(),
  position: z.number().nullable().describe("Ordinal within the document, if recorded."),
  text: z.string().describe("The passage itself, exactly as retrieval sees it."),
  existingQuestionCount: z
    .number()
    .describe("Eval questions already labeled to this chunk under this config."),
});

export const ListChunksOutputSchema = z.object({
  chunks: z.array(ChunkShape),
  total: z.number().describe("Chunks in scope, across all pages."),
  nextOffset: z
    .number()
    .nullable()
    .describe("Pass as `offset` for the next page. null means this was the last page."),
});

export type ChunkPage = z.infer<typeof ListChunksOutputSchema>;

export type ListChunksResult =
  | { ok: true; page: ChunkPage }
  | { ok: false; error: string };

export async function listChunks(args: {
  configId: string;
  offset?: number;
  limit?: number;
  documentId?: string;
}): Promise<ListChunksResult> {
  const { offset, limit } = chunkPage(args.offset, args.limit);

  const scoped = await withToolConfig(args.configId, () =>
    listChunkPage(offset, limit, args.documentId),
  );
  if (!scoped.ok) return scoped;

  const rows = scoped.value;
  return {
    ok: true,
    page: {
      chunks: rows.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        fileName: r.fileName,
        position: r.position,
        text: r.text,
        existingQuestionCount: r.questionCount,
      })),
      // The window function repeats the total on every row; an empty page has no
      // row to read it off, and zero is the right answer there anyway.
      total: rows[0]?.total ?? 0,
      nextOffset: nextOffset(offset, limit, rows.length),
    },
  };
}
