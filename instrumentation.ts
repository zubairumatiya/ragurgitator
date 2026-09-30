import { onRequestError as reportEscapedError } from "@/lib/observability/sentry";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

// Sees only errors that escape a handler. The NDJSON producer and the detached
// queue run after the handler returns, so they capture by hand (docs/obs-1-sentry-plan.md §0).
// Scope boundaries capture escaping errors themselves, with the request's ids, and
// this skips those — see lib/observability/sentry.ts.
export const onRequestError = reportEscapedError;
