// PROVIDER ADAPTERS — the only place that talks to a batch API over the wire.
//
// Three providers behind one interface (submit / poll / results / cancel):
//   • Anthropic — native SDK, for LLM jobs on a claude-* model. 24h window, −50%.
//   • OpenAI — native SDK, for LLM jobs on a gpt-* model. 24h window (the only one
//     it accepts), −50%.
//   • Voyage — REST (no SDK batch surface in voyageai@0.2.1), used by
//     ingest_embedding. Files API + JSONL, OpenAI-Batch-compatible. 12h, −33%.
//
// WHICH LLM PROVIDER a job uses is decided by its build() from the model it put in
// the requests, never per-kind — so the same batch lever is available to a GPT
// config as to a Claude one. What makes that cheap is that requests are ALWAYS
// Anthropic-shaped: the OpenAI adapter translates each line on the way out and each
// result body on the way back (shared verbatim with the synchronous path), so every
// apply() handler reads `body.content[0].text` without knowing who served it.
//
// Everything above this line is provider-agnostic. Raw provider status strings are
// mapped here and nowhere else.
//
// The live calls can't be exercised in the unit suite (async windows, real keys,
// real billing), so status mapping and result parsing are pulled into pure exported
// helpers — the parts most likely to be wrong — and unit-tested with canned
// payloads.
//
// EVERY CALL IN THIS FILE IS RECORDED TO THE KEY LEDGER (0072) AT ZERO COST, and
// the zero is the point rather than a reason to skip it. Submitting, polling,
// fetching and cancelling spend no tokens, so no other ledger in the app has ever
// had a reason to see them — which makes them precisely the calls an attacker
// enumerating a stolen key would produce, and the ones a runaway poller would
// produce too. The tokens a batch eventually burns are metered where its results
// are applied; what belongs here is the fact that the key was used at all.
import type Anthropic from "@anthropic-ai/sdk";
import { toFile } from "openai";
import { trackKeyUsage, type KeyUsageKind } from "@/lib/auth/keyUsageStore";
import { activeUserId } from "@/lib/auth/userScope";
import { openProviderKey } from "@/lib/auth/providerKeys";
import { anthropicFor, openaiFor, MissingProviderKeyError } from "@/lib/llm/client";
import { toAnthropicMessage, toChatParams } from "@/lib/llm/openaiChat";
import {
  type BatchProvider,
  type BatchRequest,
  type BatchResultRow,
  type ProviderStatus,
} from "@/lib/batch/types";
import {
  mapAnthropicStatus,
  mapOpenAiStatus,
  mapVoyageStatus,
  parseOpenAiResults,
  parseVoyageResults,
} from "@/lib/batch/providerStatus";

export { mapAnthropicStatus, mapOpenAiStatus, mapVoyageStatus, parseOpenAiResults, parseVoyageResults };

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

// One tracked control-plane call. `provider` is the BatchProvider, which happens to
// name the same three vendors as ProviderId for every batch we can submit — voyage
// batches are embeddings, the other two are messages — so no translation is needed.
//
// The model is only knowable at submit time and only for the providers that carry
// it: Anthropic and OpenAI put it on each request line, Voyage at batch level.
// Poll, fetch and cancel address a batch by id and have no model at all, so they
// record "" rather than guessing one from a job row this file cannot see.
function tracked<T>(
  provider: BatchProvider,
  kind: KeyUsageKind,
  model: string,
  call: () => Promise<T>,
): Promise<T> {
  return trackKeyUsage({ provider, model, surface: "batch", kind }, call);
}

// The model on the first request line, for the two providers that put it there. The
// lines of one batch always share a model — build() puts it there — so the first is
// the batch's.
function modelOfFirst(requests: BatchRequest[]): string {
  const params = requests[0]?.params as { model?: string } | undefined;
  return params?.model ?? "";
}

// Anthropic

// Every method resolves the ACTIVE user's key. The batch poller is a
// session-bearing route (app/api/batch/poll/route.ts runs inside
// withRequestUser), so there is always a user in scope here — a batch is only
// ever advanced by a request from the person who owns it. That is what makes
// per-job key resolution unnecessary: the scope is already the owner's.
const anthropicAdapter: ProviderAdapter = {
  async submit(requests) {
    const anthropicClient = await anthropicFor(activeUserId());
    const batch = await tracked("anthropic", "batch_submit", modelOfFirst(requests), () =>
      anthropicClient.messages.batches.create({
        requests: requests.map((r) => ({
          custom_id: r.customId,
          params: r.params as Anthropic.Messages.MessageCreateParamsNonStreaming,
        })),
      }),
    );
    return { providerBatchId: batch.id, outputFileId: null };
  },

  async poll(id) {
    const anthropicClient = await anthropicFor(activeUserId());
    const b = await tracked("anthropic", "batch_poll", "", () =>
      anthropicClient.messages.batches.retrieve(id),
    );
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
    // The tracked span covers OPENING the stream, not draining it: the decoder
    // yields rows lazily, and a parse failure three thousand rows in is our bug,
    // not a rejected key use.
    const decoder = await tracked("anthropic", "batch_fetch", "", () =>
      anthropicClient.messages.batches.results(id),
    );
    for await (const row of decoder) {
      const res = row.result;
      out.push({
        customId: row.custom_id,
        // Same spelling boundary as mapAnthropicStatus: their per-request result
        // type is single-l "canceled", ours is double-l. Everything else agrees.
        outcome: res.type === "canceled" ? "cancelled" : res.type,
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
    await tracked("anthropic", "batch_cancel", "", () =>
      anthropicClient.messages.batches.cancel(id),
    );
  },
};

// OpenAI. Structurally the Voyage adapter (upload JSONL → create → poll →
// download), but through the SDK rather than raw fetch, and with the MODEL PER LINE
// rather than at batch level: Chat Completions batching puts the whole request body
// on each row, which is why SubmitMeta stays {} here as it does for Anthropic.
//
//   {"custom_id":"…","method":"POST","url":"/v1/chat/completions","body":{…}}
//
// The body is toChatParams() of the same Anthropic params the synchronous path
// sends — one translation, two transports.

const OPENAI_BATCH_ENDPOINT = "/v1/chat/completions" as const;
// The ONLY window the API accepts (Anthropic is also 24h; Voyage is 12h — there
// is no shared constant worth extracting from three unrelated vendor limits).
const OPENAI_COMPLETION_WINDOW = "24h" as const;

const openaiAdapter: ProviderAdapter = {
  async submit(requests) {
    const client = await openaiFor(activeUserId());

    const jsonl = requests
      .map((r) =>
        JSON.stringify({
          custom_id: r.customId,
          method: "POST",
          url: OPENAI_BATCH_ENDPOINT,
          body: toChatParams(r.params as Anthropic.Messages.MessageCreateParamsNonStreaming),
        }),
      )
      .join("\n");

    // TWO ledger rows, not one. The upload and the create are separate calls to
    // OpenAI and either can be the one that gets rejected; collapsing them would
    // make a failed upload look like a failed batch create and send whoever is
    // reconciling to the wrong place.
    const model = modelOfFirst(requests);
    const upload = await toFile(Buffer.from(jsonl, "utf8"), "batch.jsonl", {
      type: "application/jsonl",
    });
    const file = await tracked("openai", "batch_submit", model, () =>
      client.files.create({ file: upload, purpose: "batch" }),
    );
    const batch = await tracked("openai", "batch_submit", model, () =>
      client.batches.create({
        input_file_id: file.id,
        endpoint: OPENAI_BATCH_ENDPOINT,
        completion_window: OPENAI_COMPLETION_WINDOW,
      }),
    );
    // The output file id doesn't exist yet at create time — poll fills it in.
    return { providerBatchId: batch.id, outputFileId: null };
  },

  async poll(id) {
    const client = await openaiFor(activeUserId());
    const b = await tracked("openai", "batch_poll", "", () => client.batches.retrieve(id));
    const c = b.request_counts;
    return {
      status: mapOpenAiStatus(b.status),
      requestCount: c?.total ?? 0,
      succeededCount: c?.completed ?? 0,
      // Failed rows go to a SEPARATE error_file_id (unlike Voyage, which inlines
      // them), so this count — not the results file — is what the panel renders.
      erroredCount: c?.failed ?? 0,
      outputFileId: b.output_file_id ?? null,
    };
  },

  async results(_id, outputFileId) {
    if (!outputFileId) throw new Error("OpenAI batch completed without an output file id.");
    const client = await openaiFor(activeUserId());
    const res = await tracked("openai", "batch_fetch", "", () =>
      client.files.content(outputFileId),
    );
    return parseOpenAiResults(await res.text(), toAnthropicMessage);
  },

  async cancel(id) {
    const client = await openaiFor(activeUserId());
    await tracked("openai", "batch_cancel", "", () => client.batches.cancel(id));
  },
};

// Voyage (REST — https://api.voyageai.com/v1, Files API + JSONL)

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
    // Two rows here for the same reason as OpenAI's submit — upload and create are
    // separate requests and fail separately.
    const file = await tracked("voyage", "batch_submit", meta.model ?? "", () =>
      voyageJson<{ id: string }>("/files", { method: "POST", body: form }),
    );

    // 3. Create the batch. Model + embedding params live at the batch level.
    const request_params: Record<string, unknown> = { model: meta.model };
    if (meta.inputType) request_params.input_type = meta.inputType;
    if (meta.outputDimension) request_params.output_dimension = meta.outputDimension;
    if (meta.outputDtype) request_params.output_dtype = meta.outputDtype;
    const batch = await tracked("voyage", "batch_submit", meta.model ?? "", () =>
      voyageJson<{ id: string }>("/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint: "/v1/embeddings",
          completion_window: "12h",
          request_params,
        }),
      }),
    );
    return { providerBatchId: batch.id, outputFileId: null };
  },

  async poll(id) {
    const b = await tracked("voyage", "batch_poll", "", () =>
      voyageJson<{
        status: string;
        output_file_id?: string | null;
        request_counts?: { total?: number; completed?: number; failed?: number };
      }>(`/batches/${id}`, { method: "GET" }),
    );
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
    // The status check is INSIDE the span: this is the one call in the file that
    // does not go through voyageJson, so a 401 becomes an error here or nowhere,
    // and the ledger would otherwise record a rejected fetch as a successful one.
    const body = await tracked("voyage", "batch_fetch", "", async () => {
      const res = await fetch(`${VOYAGE_BASE}/files/${outputFileId}/content`, {
        headers: { Authorization: await voyageAuth() },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Voyage results fetch → ${res.status}: ${detail.slice(0, 300)}`);
      }
      return res.text();
    });
    return parseVoyageResults(body);
  },

  async cancel(id) {
    await tracked("voyage", "batch_cancel", "", () =>
      voyageJson(`/batches/${id}/cancel`, { method: "POST" }),
    );
  },
};

const ADAPTERS: Record<BatchProvider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  voyage: voyageAdapter,
};

export function adapterFor(provider: BatchProvider): ProviderAdapter {
  return ADAPTERS[provider];
}
