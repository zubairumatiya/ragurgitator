// ---------------------------------------------------------------------------
// Stream a sequence of events to the client as newline-delimited JSON (NDJSON):
// one JSON object per line, flushed as soon as it's produced. Used by the long-
// running POST routes (ingest, eval) to drive live progress bars.
//
// The `run` callback owns its own error handling — it should catch and emit a
// typed error event so the client can surface it. This helper only manages the
// stream lifecycle and the headers that keep proxies from buffering it.
//
// `start(controller)` runs AFTER the route handler returns, i.e. outside the
// caller's AsyncLocalStorage scope — so the active config (and any other context)
// set by withRequestConfig would be lost inside `run`. AsyncResource.bind
// captures the async context at call time (when ndjsonStream is invoked, still
// inside the scope) and restores it when the producer runs. See
// lib/http/configScope.ts.
// ---------------------------------------------------------------------------
import { AsyncResource } from "node:async_hooks";

export function ndjsonStream<E>(
  run: (send: (event: E) => void) => Promise<void>,
): Response {
  const boundRun = AsyncResource.bind(run);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: E) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client disconnected mid-stream; nothing left to do.
        }
      };
      try {
        await boundRun(send);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed (e.g. client aborted) — ignore.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}
