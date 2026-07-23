// ---------------------------------------------------------------------------
// QUERY TIME, STEP 2: GENERATE  (the "G" in RAG)
//
// Takes the retrieved chunks + the user's question, builds a grounded prompt,
// calls the LLM, and returns the answer.
//
// Prompting decisions:
//   - system prompt sets the role and the "answer only from context" rule
//   - context chunks are wrapped in XML-ish tags so the model can tell where
//     each one starts/ends (Claude is trained to follow this convention)
//   - each chunk is labeled with its source so the model can cite if asked,
//     and so a future re-ranker can use the same labels
// ---------------------------------------------------------------------------
import { config } from "@/lib/config";
import { activeConfig } from "@/lib/rag/activeConfig";
import { meteredMessage } from "@/lib/rag/meter";
import type { RetrievedChunk } from "@/types/rag";

// The answer plus the REAL token usage the call reported. Usage is what makes the
// saver-cascade saving exact (pipeline.answerWithCascade prices the cheap-vs-strong
// delta from these counts) — it was previously thrown away here.
export type GeneratedAnswer = {
  answer: string;
  inputTokens: number;
  outputTokens: number;
};

const SYSTEM_PROMPT = `You are a helpful assistant answering questions about a user-provided document set.

Rules:
- Answer using ONLY the information inside the <context> block. Do not use outside knowledge.
- If the context does not contain enough information to answer, say "I don't know based on the provided documents." Do not guess.
- Be concise. Quote short snippets from the context when it strengthens the answer.`;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  model: string = activeConfig().llmModel,
): Promise<GeneratedAnswer> {
  const userMessage = buildUserMessage(question, chunks);

  // meteredMessage records this call's gross spend against the "chat" surface.
  const response = await meteredMessage("chat", {
    model,
    max_tokens: config.maxAnswerTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  // The Messages API returns content as an array of blocks; for a non-tool,
  // non-streaming call there's a single text block.
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("LLM returned no text content.");
  return {
    answer: block.text,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function buildUserMessage(question: string, chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return `<context>\n(no relevant context was retrieved)\n</context>\n\nQuestion: ${question}`;
  }

  const contextBlocks = chunks
    .map((c, i) => {
      const source = `doc:${c.chunk.chunk.documentId.slice(0, 8)} #${c.chunk.chunk.position}`;
      return `<chunk id="${i + 1}" source="${source}">\n${c.chunk.chunk.text}\n</chunk>`;
    })
    .join("\n\n");

  return `<context>\n${contextBlocks}\n</context>\n\nQuestion: ${question}`;
}
