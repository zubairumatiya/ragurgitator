// ---------------------------------------------------------------------------
// PROVIDER ADAPTERS — the only place that talks to a batch API over the wire.
//
// Two providers behind one interface (submit / poll / results / cancel):
//   • Anthropic — native SDK (client.messages.batches.*), used by the three LLM
//     jobs. 24h window, −50%.
//   • Voyage — REST (no SDK batch surface in voyageai@0.2.1), used by
//     ingest_embedding. Files API + JSONL, OpenAI-Batch-compatible. 12h, −33%.
//
// Everything above this line is provider-agnostic (normalized BatchStatus /
// BatchResultRow). Raw provider status strings are mapped here and nowhere else.
//
// NOTE: the live calls can't be exercised in the unit suite (async windows, real
// keys, real billing). Status mapping and result parsing are pulled into pure,
// exported helpers (mapAnthropicStatus / mapVoyageStatus / parseVoyageResults)
// so those — the parts most likely to be wrong — are unit-tested with canned
// payloads. See lib/batch/providers.test.ts.
// ---------------------------------------------------------------------------
import type Anthropic from "@anthropic-ai/sdk";
import { activeUserId } from "@/lib/auth/userScope";
import { openProviderKey } from "@/lib/auth/providerKeys";
import { anthropicFor, MissingProviderKeyError } from "@/lib/llm/client";
import {
  type BatchProvider,
  type BatchRequest,
  type BatchResultRow,
  type ProviderStatus,
} from "@/lib/batch/types";
import {
  mapAnthropicStatus,
  mapVoyageStatus,
  parseVoyageResults,
} from "@/lib/batch/providerStatus";

export { mapAnthropicStatus, mapVoyageStatus, parseVoyageResults };

// Batch-level params Voyage needs at creation (Anthropic carries these per
// request, so it ignores this).
export type SubmitMeta = {
  model?: string;
  inputType?: "document" | "query" | null;
  outputDimension?: number | null;
  outputDtype?: string | null;
};

export type SubmitResult = { providerBatchId: string; outputFileId: string | null };

export interface ProviderAdapter {
  submit(requests: BatchRequest[], meta: SubmitMeta): Promise<SubmitResult>;
  poll(providerBatchId: string): Promise<ProviderStatus>;
  results(providerBatchId: string, outputFileId: string | null): Promise<BatchResultRow[]>;
  cancel(providerBatchId: string): Promise<void>;
}

// ===========================================================================
// Anthropic
// ===========================================================================

// Every method resolves the ACTIVE user's key. The batch poller is a
// session-bearing route (app/api/batch/poll/route.ts runs inside
// withRequestUser), so there is always a user in scope here — a batch is only
// ever advanced by a request from the person who owns it. That is what makes
// per-job key resolution unnecessary: the scope is already the owner's.
const anthropicAdapter: ProviderAdapter = {
  async submit(requests) {
    const anthropicClient = await anthropicFor(activeUserId());
    const batch = await anthropicClient.messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.customId,
        params: r.params as Anthropic.Messages.MessageCreateParamsNonStreaming,
      })),
    });
    return { providerBatchId: batch.id, outputFileId: null };
  },

  async poll(id) {
    const anthropicClient = await anthropicFor(activeUserId());
    const b = await anthropicClient.messages.batches.retrieve(id);
    const c = b.request_counts;
    return {
      status: mapAnthropicStatus(b.processing_status),
      requestCount: c.processing + c.succeeded + c.errored + c.canceled + c.expired,
      succeededCount: c.succeeded,
      // Expired counts as a failure for our purposes (no usable output).
      erroredCount: c.errored + c.expired,
      outputFileId: null,
    };
  },

  async results(id) {
    const out: BatchResultRow[] = [];
    const anthropicClient = await anthropicFor(activeUserId());
    const decoder = await anthropicClient.messages.batches.results(id);
    for await (const row of decoder) {
      const res = row.result;
      out.push({
        customId: row.custom_id,
        outcome: res.type,
        body: res.type === "succeeded" ? res.message : null,
        error:
          res.type === "errored"
            ? JSON.stringify(res.error)
            : res.type === "succeeded"
              ? undefined
              : res.type,
      });
    }
    return out;
  },

  async cancel(id) {
    const anthropicClient = await anthropicFor(activeUserId());
    await anthropicClient.messages.batches.cancel(id);
  },
};

// ===========================================================================
// Voyage (REST — https://api.voyageai.com/v1, Files API + JSONL)
// ===========================================================================

const VOYAGE_BASE = "https://api.voyageai.com/v1";

// Voyage has no batch surface in voyageai@0.2.1, so this path builds the
// Authorization header by hand rather than going through voyageFor(). That means
// it is the one place in the app that handles a raw key string outside a client
// constructor — hence .expose() inline in the header literal, never into a
// variable, and a MissingProviderKeyError rather than a keyless request that
// would come back as an opaque 401.
async function voyageAuth(): Promise<string> {
  const secret = await openProviderKey(activeUserId(), "voyage");
  if (!secret) throw new MissingProviderKeyError("voyage");
  return `Bearer ${secret.expose()}`;
}

async function voyageJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${VOYAGE_BASE}${path}`, {
    ...init,
    headers: { Authorization: await voyageAuth(), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

const voyageAdapter: ProviderAdapter = {
  async submit(requests, meta) {
    // 1. JSONL: one line per request. body.input is an array; we put one text
    //    per custom_id so results map 1:1 back to a chunk.
    const jsonl = requests
      .map((r) => JSON.stringify({ custom_id: r.customId, body: r.params }))
      .join("\n");

    // 2. Upload the JSONL as a batch input file (multipart).
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "batch.jsonl");
    const file = await voyageJson<{ id: string }>("/files", { method: "POST", body: form });

    // 3. Create the batch. Model + embedding params live at the batch level.
    const request_params: Record<string, unknown> = { model: meta.model };
    if (meta.inputType) request_params.input_type = meta.inputType;
    if (meta.outputDimension) request_params.output_dimension = meta.outputDimension;
    if (meta.outputDtype) request_params.output_dtype = meta.outputDtype;
    const batch = await voyageJson<{ id: string }>("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_file_id: file.id,
        endpoint: "/v1/embeddings",
        completion_window: "12h",
        request_params,
      }),
    });
    return { providerBatchId: batch.id, outputFileId: null };
  },

  async poll(id) {
    const b = await voyageJson<{
      status: string;
      output_file_id?: string | null;
      request_counts?: { total?: number; completed?: number; failed?: number };
    }>(`/batches/${id}`, { method: "GET" });
    const rc = b.request_counts ?? {};
    return {
      status: mapVoyageStatus(b.status),
      requestCount: rc.total ?? 0,
      succeededCount: rc.completed ?? 0,
      erroredCount: rc.failed ?? 0,
      outputFileId: b.output_file_id ?? null,
    };
  },

  async results(_id, outputFileId) {
    if (!outputFileId) throw new Error("Voyage batch completed without an output file id.");
    const res = await fetch(`${VOYAGE_BASE}/files/${outputFileId}/content`, {
      headers: { Authorization: await voyageAuth() },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage results fetch → ${res.status}: ${body.slice(0, 300)}`);
    }
    return parseVoyageResults(await res.text());
  },

  async cancel(id) {
    await voyageJson(`/batches/${id}/cancel`, { method: "POST" });
  },
};

// ===========================================================================

const ADAPTERS: Record<BatchProvider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  voyage: voyageAdapter,
};

export function adapterFor(provider: BatchProvider): ProviderAdapter {
  return ADAPTERS[provider];
}
