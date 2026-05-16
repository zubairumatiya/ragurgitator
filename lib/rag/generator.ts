// ---------------------------------------------------------------------------
// QUERY TIME, STEP 2: GENERATE  (the "G" in RAG)
//
// Responsibility: take the retrieved chunks + the user's question, build a
// prompt that grounds the model in that context, call the LLM, and return
// the answer.
//
// Prompt-engineering ideas to learn here:
//   - clearly separate "context" from "question" in the prompt
//   - instruct the model to answer ONLY from the provided context and to say
//     "I don't know" when the context is insufficient (reduces hallucination)
//   - include chunk metadata so you can show citations/sources in the UI
//
// TODO: export `generateAnswer(question, chunks): Promise<string>` and
//       call the LLM through lib/llm/client.ts (don't put SDK setup here).
// ---------------------------------------------------------------------------
