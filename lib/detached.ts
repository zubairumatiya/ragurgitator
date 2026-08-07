// ---------------------------------------------------------------------------
// DETACHED WRITES — the sanctioned home for fire-and-forget telemetry.
//
// THE BUG THIS EXISTS TO PREVENT. Since 0051 a request scope IS a transaction
// (lib/db.ts), and it commits when the route handler's promise settles. A
// telemetry write started with a bare `void` inside that scope is not awaited by
// anybody, so it issues its SQL AFTER the commit that released the connection.
// It then lands on a pooled connection with no `app.user_id`, every RLS policy
// denies, the store's own catch logs a warn, and the counter silently
// under-reports. It is not a race that is sometimes lost: `isolated()` costs a
// round-trip (`savepoint s0`, then the insert) and the request needs only
// `commit` to finish, so on a served semantic-cache hit the order on the wire is
// always savepoint → commit → insert-too-late.
//
// Worse, the stale handle dispatches to a connection object directly, bypassing
// the pool. If that connection has meanwhile been handed to ANOTHER user's
// transaction, the insert's `WITH CHECK` fails and aborts their transaction —
// and then `isolated()`'s error path issues `rollback to s0`, which collides
// because postgres.js numbers savepoints per-transaction from zero. That rolls
// back the victim's work and un-aborts their transaction, so they commit
// truncated state and see no error.
//
// THE FIX. A per-request registry, drained from a single Next `after()` in one
// fresh transaction, after the response has already gone out. So the write lands
// (correctness), the user never waits for bookkeeping (the original intent —
// lib/rag/meter.ts), and there is one call shape every site can use.
//
// THE CONFIG TRAVELS WITH THE TASK, and this is the part that would fail
// silently if you got it wrong. There are THREE request-scoped
// AsyncLocalStorages, not one: the transaction (lib/db.ts), the user
// (lib/auth/userScope.ts) and the ACTIVE CONFIG (lib/rag/activeConfig.ts). Nine
// of the thirteen telemetry sites resolve their config_id at write time from the
// third one, and savingsStore answers a missing config scope with
// `if (!configId) return;` — a no-op with no warn at all, which is strictly
// worse than the bug being fixed here.
//
// `after()` does not solve that for us. Next binds the callback with
// AsyncLocalStorage.bind, which restores every store including ours — but as of
// the `after()` CALL, and the entry points call it before entering any scope.
// Moving the call inside the config scope would not work either: withRequestUser
// routes have no config scope at all, and /api/batch/poll resolves a DIFFERENT
// config per job (lib/batch/orchestrator.ts), so one request-level config is
// wrong by construction. Hence: capture at queue time, restore at flush time.
// withConfig is a bare store.run with no I/O, so that costs nothing.
//
// The flush passes RLS on the strength of the user alone: savings_totals,
// spend_totals and the semantic_cache* tables all authorize through `configs`
// (migrations/0051_rls.sql), which the flush's own withUser GUC satisfies.
//
// WHY NOT lib/db.ts, next to isolated(), whose header already explains the
// best-effort-write contract this extends: the flush needs withUser from
// lib/auth/userScope.ts, which imports lib/db.ts, and withConfig from
// lib/rag/activeConfig.ts, which imports both. Putting it there would invert the
// layering those files describe and close two import cycles to do it. This
// module imports downward only, and nothing imports it back — the telemetry
// sites are leaves and the entry points are above it.
// ---------------------------------------------------------------------------
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

// Run a best-effort write without making the caller wait for it. THE ONE CALL
// SHAPE — `await detached(() => recordSomething(...))` — and it is correct both
// inside a request and outside one, so no call site has to know which it is in.
//
// Inside a request the await resolves immediately (the work is queued for the
// flush), so latency is unchanged. Outside one — an NDJSON stream producer, a
// script — the write runs INLINE, inside the caller's own live transaction,
// which is correct and costs nothing anybody is measuring.
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
