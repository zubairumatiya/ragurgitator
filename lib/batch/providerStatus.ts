// ---------------------------------------------------------------------------
// Pure provider status-mapping + result-parsing — the parts of providers.ts
// most likely to be wrong, split out so the unit suite can exercise them with
// canned payloads (no SDK, no network). Imports only ./types (which imports
// nothing), so it loads under the tsx test runner, which doesn't resolve the
// "@/" alias.
// ---------------------------------------------------------------------------
import type { BatchResultRow, BatchStatus } from "./types";

// Anthropic: processing_status is a 3-state machine; "ended" means every request
// settled and results are fetchable.
export function mapAnthropicStatus(s: "in_progress" | "canceling" | "ended"): BatchStatus {
  if (s === "in_progress") return "in_progress";
  if (s === "canceling") return "canceling";
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
      return "canceling";
    case "cancelled":
      return "canceled";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return "in_progress";
  }
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
