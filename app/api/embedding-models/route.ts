// ---------------------------------------------------------------------------
// API route: GET /api/embedding-models
//
// Lists every embedding model as a base-model option for the config picker, with
// whether it's selectable right now (has a vector table AND its provider is
// available — a key for OpenAI/Cohere, nothing for the in-process local models)
// and, if not, why. The picker greys out non-selectable models and shows the
// reason. This is GLOBAL (provider/env state), not config-scoped, so it doesn't
// run inside withRequestConfig. See lib/rag/embeddingModels.listBaseModelOptions.
// ---------------------------------------------------------------------------
import { listBaseModelOptions } from "@/lib/rag/embeddingModels";

export async function GET() {
  return Response.json({ models: listBaseModelOptions() });
}
