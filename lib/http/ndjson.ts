// Stream a sequence of events to the client as newline-delimited JSON: one JSON
// object per line, flushed as soon as it's produced. Used by the long-running POST
// routes (ingest, eval) to drive live progress bars.
//
// The `run` callback owns its own error handling. This helper only manages the
// stream lifecycle and the headers that keep proxies from buffering it.
//
// `start(controller)` runs AFTER the route handler returns, i.e. outside the
// caller's AsyncLocalStorage scope, so the active config would be lost inside
// `run`. AsyncResource.bind captures the async context at call time and restores
// it when the producer runs.
//
// THAT SAME "after the handler returns" IS WHY THE PRODUCER NEEDS ITS OWN
// TRANSACTION (0051). withUser's transaction commits when the handler's promise
// settles — as soon as this returns a Response, long before the producer has
// streamed anything. The bound context would faithfully restore a transaction
// handle whose connection had already gone back to the pool. So the producer
// re-enters the scope from scratch. We cannot instead hold the handler's
// transaction open: the Response has to be returned before anything is streamed,
// so awaiting the stream inside the handler deadlocks it.
//
// ORDERING IS THE WHOLE FIX, AND IT IS EASY TO GET BACKWARDS. AsyncResource.bind
// restores the ENTIRE captured context — not just the config scope it is here for,
// but the transaction scope too. So the reset has to happen INSIDE the bound
// function. Wrapping the bind from the outside, i.e.
//
//   runOutsideUserTransaction(() => withUser(user, () => boundRun(send)))
//
// opens a live transaction and then has bind immediately overwrite it with the
// committed one — worse than not resetting at all: queries then run on a pooled
// connection whose `set local app.user_id` was discarded at commit, so every policy
// denies and reads come back EMPTY RATHER THAN ERRORING. The symptom is a route
// reporting that its own data does not exist.
//
// runOutsideUserTransaction must also stay inside the bind, not be dropped: on its
// own, withUser would find the dead handle open for the same user and reuse it
// (withUserTransaction is reentrant), reaching the same failure by another route.
//
// THE DETACHED QUEUE IS SUBJECT TO THE SAME RULE: bind restores the whole context,
// so a producer would otherwise inherit the handler's queue — whose after() fires
// when the stream ends, minutes away for an ingest. runOutsideDetachedQueue exits
// it, and it too must live INSIDE the bind.
//
// AND SO IS THE KEY-USAGE BUFFER (lib/auth/keyUsageStore.ts), with a sharper
// failure than either: the handler's buffer drains when the handler returns, which
// here is immediately, so an inherited one is already spent and every row the
// producer records lands in an array that will never be drained again.
//
// It needs BOTH calls, and for a while it had only the second. withKeyUsageBuffer
// is reentrant by design — a nested scope appends rather than draining its share
// early — so on its own it saw the restored handler buffer, took the reentrant
// branch, and installed nothing. Every provider call every streamed route made
// went unrecorded, silently, because a buffer nobody drains cannot report a
// failure. That is a spend control, not a counter: it is what the demo's
// per-guest embedding budget is measured from, and a guest bought 744 embeddings
// on the operator's key against a budget reading zero. runOutsideKeyUsageBuffer
// exits the dead one so the fresh install below actually happens, and like the
// other two it must live INSIDE the bind.
//
// The consequence to keep in mind: an ingest holds one pooled connection for the
// entire ingest, not for each query in it.
//
// CANCELLATION. Detachment is also why refreshing the page does not stop a run:
// enqueue throws into the swallow below and the producer carries on spending. So
// every stream registers itself in cancelRegistry.ts, announces its id as the first
// line (`run-started`), and hands `run` a `shouldStop` predicate to poll between
// units of work.
//
// `shouldStop` is a FLAG, not an abort signal: the producer's transaction commits
// when the stream ends, so a run that throws its way out loses everything it
// generated. Loops break and return normally.
//
// The `run-started` line goes out to EVERY stream, including the ones whose event
// unions don't mention it. Their client consumers switch on `type` and ignore what
// they don't know, so the extra line is inert there — check that before adding
// another consumer.
import { AsyncResource } from "node:async_hooks";

import { runOutsideKeyUsageBuffer, withKeyUsageBuffer } from "@/lib/auth/keyUsageStore";
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
        withUser(user, () =>
          // A FRESH key-usage buffer, for the third time and the third reason. Bind
          // restores the handler's buffer too, and that one drained the moment the
          // handler returned its Response — minutes before an ingest makes its
          // first embedding call — so every row the producer recorded would be
          // pushed into an array nobody will ever read again. The exit is what
          // makes the install fresh rather than reentrant; see the ordering note.
          // Innermost, so it drains into the producer's live transaction rather
          // than the committed handler one.
          runOutsideKeyUsageBuffer(() =>
            withKeyUsageBuffer(() => run(send, () => isCancelled(runId))),
          ),
        ),
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
