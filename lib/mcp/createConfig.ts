// THE `create_config` TOOL PAYLOAD — a config built from a JSON-RPC call.
//
// The point is reproducibility. A measurement run whose starting config was made by
// remembered clicks cannot honestly be re-run six months later against a different
// corpus; one made by a tool call can be, and the call is its own record of what the
// settings were.
//
// IT CREATES AN EMPTY CONFIG, ALWAYS — no `corpusIds`. A config seeded from source
// corpora comes back with `spawned: true` and needs a follow-up populate STREAM to
// embed the seeded documents, and a stream is exactly what JSON-RPC has no room
// for. Uploading documents afterwards puts the embedding inside ingest, where the
// streaming already works, and the problem disappears rather than being papered over.
//
// IT REUSES THE ROUTE'S GUARD, NOT JUST THE STORE FUNCTION. app/api/configs/route.ts
// re-checks the base model against listBaseModelOptions(availableProviders()) so a
// stale or forged selection cannot create a config with no vector table or no usable
// key. Skipping that here would make this tool a way to manufacture configs that can
// never embed anything — a failure that surfaces much later, during an ingest, with
// nothing pointing back at the call that caused it.
import "server-only";

import { z } from "zod";

import { LLM_MODELS } from "@/lib/llm/llmModels";
import { siteUrl } from "@/lib/mcp/metadata";
import { approvalUrl, baseModelRefusal, writeDeniedMessage } from "@/lib/mcp/toolPolicy";
import { hasCapability } from "@/lib/mcp/writeGrant";
import { listBaseModelOptions } from "@/lib/rag/embeddingModels";
import { createConfigWithSettings } from "@/lib/rag/configStore";
import { availableProviders } from "@/lib/rag/providerAvailability";

export const CreateConfigInput = z.object({
  name: z.string().optional().describe("Display name. Omit for the derived label."),
  baseModel: z
    .string()
    .describe("Embedding model id. Must be selectable — call describe_config to see one in use."),
  chunkSize: z.number().int().min(1),
  chunkOverlap: z.number().int().min(0).describe("Must be smaller than chunkSize."),
  topK: z.number().int().min(1),
  llmModel: z.string().optional().describe("Answer-generation model. Omit for the app default."),
});

export const CreateConfigOutputSchema = z.object({
  config: z.object({
    id: z.string(),
    name: z.string().nullable(),
    label: z.string(),
    baseModel: z.string(),
    chunkSize: z.number(),
    chunkOverlap: z.number(),
    topK: z.number(),
    llmModel: z.string(),
  }),
  hint: z.string(),
});

export type CreateConfigPayload = z.infer<typeof CreateConfigOutputSchema>;

export type CreateConfigResult =
  | { ok: true; payload: CreateConfigPayload }
  | { ok: false; error: string };

export async function createConfigForAgent(args: {
  input: z.infer<typeof CreateConfigInput>;
  userId: string;
  clientId: string;
  tokenExpSeconds?: number;
}): Promise<CreateConfigResult> {
  const allowed = await hasCapability(args.userId, args.clientId, "config_create");
  if (!allowed) {
    return {
      ok: false,
      error: writeDeniedMessage(
        "config_create",
        approvalUrl(siteUrl(), args.clientId, ["config_create"], args.tokenExpSeconds),
      ),
    };
  }

  const input = args.input;
  // Zod can't express this one field-locally, and the API route states it as a
  // refinement for the same reason: an overlap that swallows the chunk produces a
  // chunker that never advances.
  if (input.chunkOverlap >= input.chunkSize) {
    return { ok: false, error: "`chunkOverlap` must be smaller than `chunkSize`." };
  }

  const refusal = baseModelRefusal(listBaseModelOptions(await availableProviders()), input.baseModel);
  if (refusal) return { ok: false, error: refusal };

  // Same posture as the PATCH route's LLM picker: judged at the control that set
  // it, because an unknown id otherwise surfaces from deep inside a generation
  // call long after this tool returned.
  if (input.llmModel && !(input.llmModel in LLM_MODELS)) {
    return { ok: false, error: `Unknown LLM model "${input.llmModel}".` };
  }

  // No withToolConfig wrapper: this tool CREATES the config, so there is none to
  // scope to. `configs` rows key on activeUserId(), which withMcpUser provides.
  const created = await createConfigWithSettings({
    name: input.name,
    corpusIds: [],
    baseModel: input.baseModel,
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
    topK: input.topK,
    llmModel: input.llmModel,
  });

  return {
    ok: true,
    payload: {
      config: {
        id: created.id,
        name: created.name,
        label: created.label,
        baseModel: created.baseModel,
        chunkSize: created.chunkSize,
        chunkOverlap: created.chunkOverlap,
        topK: created.topK,
        llmModel: created.llmModel,
      },
      hint:
        "The config is empty. Upload documents through the web app to ingest them — " +
        "ingest streams progress and takes multipart uploads, neither of which fits this protocol.",
    },
  };
}
