// Pure provider status-mapping + result-parsing — the parts of providers.ts
// most likely to be wrong, split out so the unit suite can exercise them with
// canned payloads (no SDK, no network). Imports only ./types (which imports
// nothing), so it loads under the tsx test runner, which doesn't resolve the
// "@/" alias.
import type OpenAI from "openai";
import type { BatchResultRow, BatchStatus } from "./types";

// Anthropic: processing_status is a 3-state machine; "ended" means every request
// settled and results are fetchable.
//
// NOTE THE SPELLING — Anthropic's value is single-l "canceling" (US) and ours is
// double-l "cancelling"; this function is the boundary between them. The input
// literal is THEIR contract, so it must not be respelled to match ours.
export function mapAnthropicStatus(s: "in_progress" | "canceling" | "ended"): BatchStatus {
  if (s === "in_progress") return "in_progress";
  if (s === "canceling") return "cancelling";
  return "completed";
}

// Voyage: validating / in_progress / finalizing all read as "running" for us;
// then the terminals. Unknown strings stay "in_progress" (keep polling) rather
// than wrongly terminating a live batch.
export function mapVoyageStatus(s: string): BatchStatus {
  switch (s) {
    case "validating":
    case "in_progress":
    case "finalizing":
      return "in_progress";
    case "completed":
      return "completed";
    case "cancelling":
      return "cancelling";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return "in_progress";
  }
}

// OpenAI: the same eight-state machine Voyage's Files-API-compatible surface
// copies, so the mapping is identical — kept as its own function rather than an
// alias because the two are independent vendor contracts that happen to agree
// today, and collapsing them would make a future divergence a silent one.
//
// `finalizing` deliberately maps to in_progress, NOT completed: the batch is done
// computing but the output file isn't fetchable yet, and treating it as completed
// would send the orchestrator to results() against a null output_file_id.
export function mapOpenAiStatus(s: string): BatchStatus {
  switch (s) {
    case "validating":
    case "in_progress":
    case "finalizing":
      return "in_progress";
    case "completed":
      return "completed";
    case "cancelling":
      return "cancelling"; // OpenAI/Voyage spell it double-l too — Anthropic doesn't
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return "in_progress";
  }
}

// Parse an OpenAI batch results JSONL. One line per request:
//
//   {"custom_id":"…","response":{"status_code":200,"body":{…ChatCompletion…}},"error":null}
//
// UNLIKE VOYAGE, failures are not (only) inline: OpenAI writes them to a separate
// error_file_id, so the output file is mostly succeeded rows. The failed COUNT still
// arrives through request_counts.failed — which is what the panel renders — so this
// only has to recognise the failures that do appear here rather than go fetch the
// second file.
//
// `translate` is the ChatCompletion → Anthropic Message conversion, injected rather
// than imported so this module stays free of the "@/" alias the tsx test runner
// can't resolve. providers.ts passes toAnthropicMessage, which is what makes a
// batched request and a synchronous one produce the same body.
export function parseOpenAiResults(
  jsonl: string,
  translate: (completion: OpenAI.Chat.Completions.ChatCompletion) => unknown,
): BatchResultRow[] {
  const out: BatchResultRow[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: {
      custom_id?: string;
      response?: { status_code?: number; body?: unknown };
      error?: unknown;
    };
    try {
      row = JSON.parse(t);
    } catch {
      continue;
    }
    const customId = row.custom_id ?? "";
    const status = row.response?.status_code;
    if (row.error || (status !== undefined && status !== 200) || !row.response?.body) {
      out.push({
        customId,
        outcome: "errored",
        body: null,
        error: JSON.stringify(row.error ?? { status_code: status ?? null }),
      });
      continue;
    }
    out.push({
      customId,
      outcome: "succeeded",
      body: translate(row.response.body as OpenAI.Chat.Completions.ChatCompletion),
    });
  }
  return out;
}

// Parse a Voyage results JSONL (OpenAI-compatible: one line per request, each
// with the request's custom_id and a response.body.data[].embedding). Malformed
// lines are skipped; a line carrying `error` becomes an errored row.
export function parseVoyageResults(jsonl: string): BatchResultRow[] {
  const out: BatchResultRow[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: {
      custom_id?: string;
      response?: { status_code?: number; body?: { data?: { embedding?: number[] }[] } };
      error?: unknown;
    };
    try {
      row = JSON.parse(t);
    } catch {
      continue;
    }
    const customId = row.custom_id ?? "";
    if (row.error) {
      out.push({ customId, outcome: "errored", body: null, error: JSON.stringify(row.error) });
      continue;
    }
    const data = row.response?.body?.data ?? [];
    out.push({ customId, outcome: "succeeded", body: data });
  }
  return out;
}
