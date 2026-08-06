// ---------------------------------------------------------------------------
// API route: GET /api/embedding-models
//
// Lists every embedding model as a base-model option for the config picker, with
// whether it's selectable right now (has a vector table AND its provider is
// available — a saved key for Voyage/OpenAI/Cohere, LOCAL_EMBEDDINGS for the
// in-process local models) and, if not, why. The picker greys out non-selectable
// models and shows the reason.
//
// PER-USER but not config-scoped: availability is a fact about the caller's own
// saved keys (strict BYOK), and the same model list answers for every config
// they own — so this runs inside withRequestUser rather than withRequestConfig.
// See lib/rag/embeddingModels.listBaseModelOptions.
// ---------------------------------------------------------------------------
import { listBaseModelOptions } from "@/lib/rag/embeddingModels";
import { availableProviders } from "@/lib/rag/providerAvailability";
import { withRequestUser } from "@/lib/http/configScope";

export async function GET() {
  return withRequestUser(async () => {
    return Response.json({ models: listBaseModelOptions(await availableProviders()) });
  });
}
