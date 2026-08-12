// DETACHED WRITES — the sanctioned home for fire-and-forget telemetry.
//
// Since 0051 a request scope IS a transaction (lib/db.ts) that commits when the
// route handler settles. A telemetry write started with a bare `void` inside it
// issues its SQL after that commit, on a pooled connection with no `app.user_id`:
// every RLS policy denies and the counter silently under-reports. Worse, the
// stale handle bypasses the pool, so if that connection has meanwhile been handed
// to another user's transaction, the failed insert aborts THEIR work — and
// `isolated()`'s `rollback to s0` collides with their savepoint numbering, so they
// commit truncated state and see no error.
//
// The fix: a per-request registry, drained from a single Next `after()` in one
// fresh transaction, after the response has already gone out.
//
// The config travels WITH the task. `after()` restores AsyncLocalStorage as of the
// `after()` CALL, and the entry points call it before entering any scope; routes
// also differ (withRequestUser has no config scope, /api/batch/poll resolves one
// per job). So config is captured at queue time, restored at flush time. Getting
// this wrong fails silently — savingsStore answers a missing config scope with
// `if (!configId) return;`.
//
// Not in lib/db.ts beside isolated(): the flush needs withUser and withConfig,
// which both import lib/db.ts, so putting it there would close two import cycles.
import { AsyncLocalStorage } from "node:async_hooks";

import { withUser, type RequestUser } from "@/lib/auth/userScope";
import { runOutsideUserTransaction } from "@/lib/db";
import {
  activeConfigOrNull,
  withConfig,
  type ResolvedConfig,
} from "@/lib/rag/activeConfig";

type DetachedTask = { fn: () => Promise<void>; config: ResolvedConfig | null };
type DetachedQueue = DetachedTask[];

const pending = new AsyncLocalStorage<DetachedQueue>();

// The one call shape — `await detached(() => recordSomething(...))` — correct both
// inside a request and outside one. Inside, the await resolves immediately (the
// work is queued for the flush) so latency is unchanged; outside, the write runs
// inline in the caller's own transaction.
export async function detached(fn: () => Promise<void>): Promise<void> {
  const queue = pending.getStore();
  if (queue) {
    // The config is captured HERE, not read at flush time — see the header.
    queue.push({ fn, config: activeConfigOrNull() });
    return;
  }
  try {
    await fn();
  } catch (err) {
    console.warn(`[detached] ${(err as Error).message}`);
  }
}

// Install a queue for `fn` and arrange for it to be drained after the response.
// Called from the two scope entry points (lib/http/configScope.ts,
// lib/auth/dal.ts) and nowhere else.
//
// `schedule` is INJECTED rather than imported so this module stays free of
// `next/server`: it is imported by the store layer, which scripts/* run outside
// Next entirely. The two entry points pass Next's `after`.
//
// Reentrant, like withUserTransaction: a nested entry reuses the installed queue
// rather than registering a second flush for the same work.
export function withDetachedQueue<T>(
  user: RequestUser,
  schedule: (flush: () => Promise<void>) => void,
  fn: () => Promise<T>,
): Promise<T> {
  if (pending.getStore()) return fn();
  const queue: DetachedQueue = [];
  try {
    schedule(() => flushDetached(user, queue));
  } catch {
    // E468 (called outside a request scope) or E91 (no waitUntil on this
    // platform). Both throw synchronously from after(). Leave the queue
    // uninstalled so detached() falls back to running inline, which is the
    // pre-existing behavior and still correct.
    return fn();
  }
  return pending.run(queue, fn);
}

// Run `fn` with NO queue installed, so detached() inside it runs inline. Exists
// for lib/http/ndjson.ts, alongside runOutsideUserTransaction and for the same
// reason — see the ordering note in that file.
export function runOutsideDetachedQueue<T>(fn: () => Promise<T>): Promise<T> {
  return pending.exit(fn);
}

async function flushDetached(user: RequestUser, queue: DetachedQueue): Promise<void> {
  if (queue.length === 0) return;
  // Take the tasks, so a detached() reached from inside a flushed task can
  // neither be lost nor run twice.
  const tasks = queue.splice(0);
  try {
    await runOutsideUserTransaction(() =>
      // runOutsideUserTransaction is NOT belt-and-braces: after() restores the
      // async context as of the after() call, and a nested entry point can make
      // that call with a transaction already open. Without the exit, withUser
      // would find the committed handle and reuse it (withUserTransaction is
      // reentrant) — the exact failure lib/http/ndjson.ts's header describes.
      withUser(user, () =>
        // pending.exit for the mirror-image reason: a flushed task that queues
        // more work must take the inline path, not append to a queue nobody
        // will drain again.
        pending.exit(async () => {
          for (const task of tasks) {
            try {
              await (task.config ? withConfig(task.config, task.fn) : task.fn());
            } catch (err) {
              console.warn(`[detached] task failed: ${(err as Error).message}`);
            }
          }
        }),
      ),
    );
  } catch (err) {
    // The per-task catch cannot see this one: opening the transaction itself can
    // fail. Left unguarded it reaches Next's onTaskError, which console.errors
    // "An error occurred in a function passed to after()" — an alarming message
    // for a counter.
    console.warn(`[detached] flush failed: ${(err as Error).message}`);
  }
}
