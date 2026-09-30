// MISSING-KEY DETECTION (server side) — turns a thrown MissingProviderKeyError
// into the wire shapes declared in ./missingKey.
//
// Separate from that module only because MissingProviderKeyError lives in
// lib/llm/client.ts, which is `server-only`; the contract itself has to be
// importable from a client component. Everything here is one-line glue, and it
// exists so the JSON path and the NDJSON path cannot drift into two different
// answers to the same failure.
import "server-only";

import { isMissingProviderKey } from "@/lib/llm/client";
import {
  MISSING_PROVIDER_KEY,
  type MissingKeyBody,
  type StreamErrorEvent,
} from "@/lib/http/missingKey";
import { captureException } from "@/lib/observability/sentry";

// The 400 for a plain JSON route, or null when this isn't a missing-key error
// (so a caller can `?? rethrow`). 400 rather than 500 because the request is
// well-formed and the server is healthy — it is simply unsatisfiable until the
// user acts. Not 402: that status means payment is owed to US, which is the
// opposite of what strict BYOK arranges, and proxies treat it oddly besides.
export function missingKeyResponse(err: unknown): Response | null {
  if (!isMissingProviderKey(err)) return null;
  const body: MissingKeyBody = {
    error: err.message,
    provider: err.provider,
    code: MISSING_PROVIDER_KEY,
  };
  return Response.json(body, { status: 400 });
}

// The error event for an NDJSON route. Always returns an event — a non-missing-key
// error becomes the ordinary `{type:"error", message}` with `fallback` when the
// throw carried no message — so the twelve streaming catch blocks are one line
// each and none of them can forget the enriched case.
//
// It is also the NDJSON producer's Sentry capture (Trap 1 in
// docs/obs-1-sentry-plan.md): those catch blocks swallow the error into an event,
// so Next's onRequestError never sees it. The bound context is live here, so the
// request's tags ride along. A missing key is the user's to fix, not a defect,
// and is not reported.
export function streamError(err: unknown, fallback: string): StreamErrorEvent {
  const message = err instanceof Error ? err.message : fallback;
  if (!isMissingProviderKey(err)) {
    captureException(err, { tags: { site: "ndjson" } });
    return { type: "error", message };
  }
  return {
    type: "error",
    message,
    provider: err.provider,
    code: MISSING_PROVIDER_KEY,
  };
}
