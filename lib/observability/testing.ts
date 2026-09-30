// Test support for the Sentry wrapper: an in-memory transport and a stand-in for
// the per-request isolation scope Sentry forks under Next. Lives here, not in
// test/, because sweep 11 keeps every @sentry/ import inside lib/observability/.
// Nothing in the app imports it.
import * as Sentry from "@sentry/nextjs";

import { initSentry } from "./sentry";

// An envelope is newline-separated JSON: one envelope header, then header/payload
// pairs. Only items of the given type are kept.
function eventsIn(
  body: string | Uint8Array,
  type: "event" | "span" = "event",
): Record<string, unknown>[] {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const lines = text.split("\n").filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if (JSON.parse(lines[i]).type === type) out.push(JSON.parse(lines[i + 1]));
  }
  return out;
}

// Init with a dummy DSN and a transport that pushes each event into the returned
// array. Nothing leaves the process.
export function initSentryInMemory(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  initSentry({
    dsn: "https://public@o0.ingest.sentry.io/0",
    tracesSampleRate: 0,
    transport: (options: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(options, async (request) => {
        events.push(...eventsIn(request.body));
        return { statusCode: 200 };
      }),
  });
  return events;
}

// A finished span as the SDK ships it, attributes unwrapped from their typed
// {value, type} form. `is_segment` marks the root (what Sentry calls a segment).
export type ShippedSpan = {
  name: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  is_segment: boolean;
  status: string;
  attributes: Record<string, unknown>;
};

// Tracing on at 100%, keeping every span that ships. SDK 11 streams spans as
// `span` items (application/vnd.sentry.items.span.v2+json), not transactions.
export function initSentryTracingInMemory(): ShippedSpan[] {
  const spans: ShippedSpan[] = [];
  initSentry({
    dsn: "https://public@o0.ingest.sentry.io/0",
    tracesSampleRate: 1,
    transport: (options: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(options, async (request) => {
        for (const item of eventsIn(request.body, "span")) {
          for (const raw of (item as { items: Record<string, unknown>[] }).items) {
            const attrs = (raw.attributes ?? {}) as Record<string, { value: unknown }>;
            spans.push({
              ...(raw as Omit<ShippedSpan, "attributes">),
              attributes: Object.fromEntries(
                Object.entries(attrs).map(([k, v]) => [k, v.value]),
              ),
            });
          }
        }
        return { statusCode: 200 };
      }),
  });
  return spans;
}

// What Next's instrumentation does for each request: a fresh isolation scope, so
// tags set by one request are not seen by another.
export function withRequestIsolation<T>(fn: () => T): T {
  return Sentry.withIsolationScope(fn);
}
