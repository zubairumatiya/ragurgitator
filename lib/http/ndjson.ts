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
//
// THAT SAME "after the handler returns" IS WHY THE PRODUCER NEEDS ITS OWN
// TRANSACTION (0051). withUser now opens the transaction that carries the
// identity RLS reads, and it commits when the handler's promise settles — which
// happens as soon as this function returns a Response, long before the producer
// has streamed anything. The bound async context would faithfully restore a
// transaction handle whose connection had already gone back to the pool, so
// every store call in an ingest or an eval would fail on a dead handle.
//
// So the producer re-enters the scope from scratch: runOutsideUserTransaction
// discards the captured (committed) handle, and withUser opens a live one that
// lives exactly as long as the stream does. We cannot instead hold the handler's
// transaction open until the stream finishes — the Response has to be returned
// before anything is streamed, so awaiting the stream inside the handler
// deadlocks it.
//
// ORDERING IS THE WHOLE FIX, AND IT IS EASY TO GET BACKWARDS. AsyncResource.bind
// restores the ENTIRE async context captured at bind time — not just the config
// scope it is here for, but the transaction scope too. So the reset has to
// happen INSIDE the bound function. Wrapping the bind from the outside, i.e.
//
//   runOutsideUserTransaction(() => withUser(user, () => boundRun(send)))
//
// opens a live transaction and then has bind immediately overwrite it with the
// committed one, which is worse than not resetting at all: queries then run on a
// pooled connection whose `set local app.user_id` was discarded at commit, so
// app.current_user_id() is NULL, every policy denies, and reads come back EMPTY
// RATHER THAN ERRORING. The symptom is a route reporting that its own data does
// not exist.
//
// runOutsideUserTransaction must also stay inside the bind, not be dropped. On
// its own, withUser would find the dead handle open for the same user and reuse
// it (lib/db.ts, withUserTransaction is reentrant), reaching the same failure by
// a different route.
//
// THE DETACHED QUEUE IS SUBJECT TO THE SAME RULE, for the same reason: bind
// restores the whole context, so a producer would otherwise inherit the
// handler's queue — whose after() fires when the RESPONSE completes, i.e. when
// the stream ends, which for an ingest is minutes away. Rather than reason about
// that window, runOutsideDetachedQueue exits it, and it too must live INSIDE the
// bind. detached() then runs inline, inside the producer's own live transaction:
// correct, and latency in a minutes-long ingest is not a concern.
//
// The consequence to keep in mind: an ingest holds one pooled connection for the
// entire ingest, not for each query in it.
//
// CANCELLATION. Detachment is also why refreshing the page does not stop a run:
// enqueue throws into the swallow below and the producer carries on spending. So
// every stream registers itself in lib/http/cancelRegistry.ts, announces its id
// as the first line (`run-started`), and hands `run` a `shouldStop` predicate to
// poll between units of work. POST /api/eval/cancel flips the flag.
//
// `shouldStop` is a FLAG, not an abort signal: the producer's transaction commits
// when the stream ends, so a run that throws its way out loses everything it
// generated. Loops break and return normally. See cancelRegistry.ts.
//
// The `run-started` line goes out to EVERY stream, including the ones whose event
// unions don't mention it (ingest, clusters, autotune). Their client consumers
// switch on `type` and ignore what they don't know, so the extra line is inert
// there — check that before adding another consumer.
// ---------------------------------------------------------------------------
import { AsyncResource } from "node:async_hooks";

import { activeUser, withUser } from "@/lib/auth/userScope";
import { registerRun, isCancelled, unregisterRun } from "@/lib/http/cancelRegistry";
import { runOutsideUserTransaction } from "@/lib/db";
import { runOutsideDetachedQueue } from "@/lib/detached";

// The first line of every NDJSON stream, carrying the id a cancel request needs.
// Not part of any route's event union — see the note above.
export type RunStartedEvent = { type: "run-started"; runId: string };

export function ndjsonStream<E>(
  run: (send: (event: E) => void, shouldStop: () => boolean) => Promise<void>,
): Response {
  // Read while the caller's scope is still current; the producer runs later.
  const user = activeUser();
  // Registered here rather than inside start(), so the run is cancellable from
  // the moment the client has its id — there is no window where a cancel that
  // arrives "too early" is silently dropped.
  const runId = registerRun(user.id);
  // Bind the re-entry, not `run` itself — see the ordering note above.
  const boundRun = AsyncResource.bind((send: (event: E) => void) =>
    runOutsideDetachedQueue(() =>
      runOutsideUserTransaction(() =>
        withUser(user, () => run(send, () => isCancelled(runId))),
      ),
    ),
  );
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Client disconnected mid-stream; nothing left to do.
        }
      };
      const send = (event: E) => emit(event);
      emit({ type: "run-started", runId } satisfies RunStartedEvent);
      try {
        await boundRun(send);
      } finally {
        unregisterRun(runId);
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
