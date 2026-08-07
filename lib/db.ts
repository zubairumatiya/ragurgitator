// ---------------------------------------------------------------------------
// Shared Postgres clients — TWO of them, which is the whole point of this file.
//
// We connect through Supabase's transaction pooler, which means prepared
// statements aren't supported — `prepare: false` is required or the postgres
// client will throw "prepared statement does not exist" once the pooler
// recycles its backend session.
//
//   sql             the store layer's handle. Connects as `rag_app`, which has
//                   NOBYPASSRLS, so 0051's policies actually bite. Every query
//                   runs inside a transaction that has already set the
//                   `app.user_id` GUC the policies read.
//
//   privilegedSql   connects as `postgres` (rolbypassrls). Exactly three
//                   callers, and it should never gain a fourth without a good
//                   reason: account deletion (deleting an auth.users row, which
//                   is how we avoid keeping a permanent service-role key in
//                   env), migrations, and scripts/backfill-embedding-cache.ts,
//                   which is deliberately cross-tenant.
//
// WHY A TRANSACTION PER SCOPE. `set local` is the only way to carry a
// per-request identity over a transaction pooler — a plain `set` would leak the
// value to whichever tenant got that backend next, which is worse than having no
// RLS at all. `set local` only survives inside an explicit transaction, so the
// scope and the transaction have to be the same thing.
//
// The cost is real and worth stating: one pooled connection is held for the
// whole scope, LLM generation included. A chat answer is 20-30s and an ingest is
// minutes. Two things measured against this database make that survivable —
// `max_connections` is 60 with ~10 in use, and
// `idle_in_transaction_session_timeout` is 0 (disabled), so a long-held
// transaction is not reaped. `statement_timeout` is 2min but applies per
// statement, not per transaction, so the idle gap while an LLM thinks is fine.
// If concurrency ever becomes the binding constraint, `max` below is the dial.
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Add it to .env.local.");
}

// No fallback to DATABASE_URL on purpose. A missing restricted URL would
// silently run the entire store layer as a role that bypasses RLS — i.e. it
// would look like it worked, which is the one failure mode worth refusing.
const appUrl = process.env.RAG_APP_DATABASE_URL;
if (!appUrl) {
  throw new Error(
    "RAG_APP_DATABASE_URL is not set. It is the `rag_app` connection string " +
      "(see migrations/0051_rls.sql). Add it to .env.local.",
  );
}

declare global {
  var __ragSqlPrivileged: Sql | undefined;
  var __ragSqlApp: Sql | undefined;
}

export const privilegedSql =
  globalThis.__ragSqlPrivileged ??
  postgres(url, {
    prepare: false,
    ssl: "require",
    // Only the three cross-tenant callers use this, and none of them is on a
    // request path, so it does not need request-shaped headroom.
    max: 5,
  });

const appPool =
  globalThis.__ragSqlApp ??
  postgres(appUrl, {
    prepare: false,
    ssl: "require",
    // Higher than postgres.js's default 10 because connections are now held for
    // the length of a scope rather than a query, and page renders open several
    // sibling scopes (layout, page and leaves each call withPageUser).
    max: 15,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__ragSqlPrivileged = privilegedSql;
  globalThis.__ragSqlApp = appPool;
}

type UserTransaction = { userId: string; tx: Sql };

const txStore = new AsyncLocalStorage<UserTransaction>();

// Open the transaction that carries a user's identity, and run `fn` inside it.
// Called from lib/auth/userScope.ts's withUser — not directly.
//
// Reentrant: nested scopes for the same user reuse the open transaction rather
// than opening a second one on a second connection. That matters because
// withPageUser has 11 call sites and a page's layout, page and leaves each enter
// the scope independently.
export function withUserTransaction<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const open = txStore.getStore();
  if (open) {
    // Two different users inside one async chain means a scope leaked across a
    // request boundary. There is no safe interpretation of that, so refuse.
    if (open.userId !== userId) {
      throw new Error(
        `withUserTransaction: nested scope for user ${userId} inside an open ` +
          `transaction for ${open.userId}.`,
      );
    }
    return fn();
  }

  return appPool
    .begin(async (tx) => {
      // FIRST statement in the transaction, so no policy can ever be evaluated
      // before the identity it reads exists. `true` = set LOCAL, discarded when
      // the transaction ends and therefore never visible to the next tenant that
      // gets this backend.
      await tx`select set_config('app.user_id', ${userId}, true)`;
      // Boxed, and this is not stylistic. postgres.js does
      // `Array.isArray(x) ? Promise.all(x) : x` on whatever the callback returns
      // (src/index.js:262), so an array result comes back as a NEW plain array —
      // which silently strips the `count` and `command` properties off a
      // postgres Result, and would await any promises the caller meant to keep.
      // A scope returns arbitrary application data, so it must not be an array
      // when postgres.js looks at it.
      return { value: await txStore.run({ userId, tx: tx as unknown as Sql }, fn) };
    })
    .then((boxed) => (boxed as { value: T }).value);
}

// Run `fn` with NO transaction in scope, so a withUser() inside it opens a fresh
// one. Exists for lib/http/ndjson.ts: AsyncResource.bind replays the async
// context captured when the route handler was still running, which includes a
// transaction handle that has since committed. Streaming producers have to start
// from a clean slate rather than inherit a dead handle.
export function runOutsideUserTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return txStore.exit(fn);
}

// Run `fn` so that a query failing inside it cannot poison the caller's
// transaction. Wrap every BEST-EFFORT database write in this — the ones whose
// contract is "record it if you can, warn and carry on if you can't".
//
// Catching the error at the call site is NOT enough any more, and this is the
// subtlest consequence of making a scope a transaction. Two things stack up.
// Postgres aborts a whole transaction the moment any statement in it errors, so
// every later statement fails with "current transaction is aborted" regardless
// of who caught what. And postgres.js records the rejection of every query run
// inside a transaction into its own `uncaughtError` and rethrows it after the
// callback returns (src/index.js:258-266) — so a swallowed failure still takes
// the transaction down. Before 0051 each of these writes was its own implicit
// transaction and a failure was genuinely local; now the blast radius is the
// entire request unless it runs in a savepoint.
//
// Outside a scope this is a pass-through, so scripts and tests are unaffected.
//
// ISOLATION IS ONLY HALF OF IT. This makes a best-effort write safe for the
// enclosing transaction; it does nothing about a write that runs after that
// transaction has COMMITTED. A bare `void someWrite()` inside a scope does
// exactly that — nobody awaits it, the handler's promise settles, the connection
// goes back to the pool, and the SQL arrives too late to have an identity. So
// every fire-and-forget write goes through detached() (lib/detached.ts), which
// queues it for a flush that runs after the response in its own transaction.
// `void` on a write is the bug this file exists to prevent, not a shorthand.
export function isolated<T>(fn: () => Promise<T>): Promise<T> {
  const open = txStore.getStore();
  if (!open) return fn();

  const handle = open.tx as unknown as {
    savepoint: (f: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  return handle
    .savepoint(async (sp) => ({
      // Re-enter the scope with the SAVEPOINT's handle, not the outer one —
      // otherwise `fn`'s queries go to the enclosing transaction and the
      // savepoint isolates nothing.
      value: await txStore.run({ userId: open.userId, tx: sp }, fn),
    }))
    .then((boxed) => (boxed as { value: T }).value);
}

// For building a static SQL FRAGMENT at module scope — a shared column list, a
// literal tuple — to be interpolated into a real query later. `sql` deliberately
// throws outside a request scope, and a module body has no scope, so the three
// `const COLUMNS = sql\`…\`` constants in the store layer would throw at import
// and take the whole app down before it served a request.
//
// Only safe because a fragment is CONSTRUCTED here and EXECUTED elsewhere:
// postgres.js inlines a nested query's strings into the outer query, and the
// outer query's handle is what runs it. So a fragment built here still executes
// inside the caller's transaction, with the GUC set and the policies applying.
//
// Do not await one of these. A fragment awaited directly runs on the bare pool
// with no identity, and RLS answers that with silence rather than an error.
export const fragment: Sql = appPool;

// Bind `value` as a jsonb parameter.
//
// USE THIS, NEVER `${JSON.stringify(value)}::jsonb`. That pattern looks obviously
// right and DOUBLE-ENCODES: the `::jsonb` cast makes Postgres resolve the
// parameter's type to jsonb, postgres.js then applies its own jsonb serializer
// (JSON.stringify) to the string you already stringified, and the column ends up
// holding a jsonb STRING SCALAR whose contents are the JSON text.
//
// It fails silently in both directions. The insert succeeds. The read back
// returns a JS string rather than the object the type annotation promises, so
// every field access is `undefined` — which surfaces later and somewhere else as
// an UNDEFINED_VALUE on a downstream insert, or as a `.map is not a function`,
// and never as an error at the site that wrote the bad row. Two tables were
// already storing string scalars this way (semantic_cache.result,
// eval_results.screen_cutoffs) before anyone noticed; see migration 0052.
//
// `sql.json` is postgres.js's own helper and is already routed through the Proxy
// below as a pure helper, so this is safe to call outside a scope too.
export function toJsonb(value: unknown) {
  return appPool.json(value as Parameters<typeof appPool.json>[0]);
}

function scopedTx(): Sql {
  const open = txStore.getStore();
  if (!open) {
    throw new Error(
      "sql used outside a withUser() scope. The store layer must run inside a " +
        "request scope so RLS has an identity to check; if this call is " +
        "genuinely cross-tenant, use privilegedSql and say why.",
    );
  }
  return open.tx;
}

// Value helpers that build a fragment rather than talk to a connection, so they
// are safe to reach for outside a scope.
const PURE_HELPERS = new Set(["json", "array", "typed"]);

// A Proxy rather than a function that returns a handle, so all 25 call sites
// keep writing `sql\`select …\`` and every existing sql.begin / sql.json keeps
// working untouched.
//
// `begin` HAS TO BE REMAPPED TO `savepoint`, and this is the one thing here that
// typechecking cannot catch — the Proxy is typed as a full Sql, but a postgres.js
// transaction handle is not one. Its Sql(handler) is built with only
// types/typed/unsafe/notify/array/json/file, plus a `savepoint` the enclosing
// scope attaches (src/index.js:85-101, 281). There is no `begin` on it, so
// forwarding the store layer's 14 sql.begin() calls verbatim would hand every
// one of them `undefined` at runtime. `savepoint(fn)` takes the same single
// callback and produces the nested-transaction semantics `begin` had.
//
// Note what that changes: those blocks are no longer independent transactions.
// An error inside one used to roll back only itself and leave earlier work
// committed; now it rolls back to a savepoint, and if it propagates it unwinds
// the whole scope-long transaction with it.
export const sql = new Proxy(function () {} as unknown as Sql, {
  apply(_target, _thisArg, args: unknown[]) {
    return (scopedTx() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop) {
    if (typeof prop === "string" && PURE_HELPERS.has(prop)) {
      return (appPool as unknown as Record<string, unknown>)[prop];
    }
    const tx = scopedTx();
    const handle = tx as unknown as Record<string | symbol, unknown> & {
      savepoint: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
    };
    if (prop === "begin") {
      return (fn: (tx: Sql) => Promise<unknown>) => handle.savepoint(fn);
    }
    const value = handle[prop];
    return typeof value === "function" ? value.bind(tx) : value;
  },
}) as Sql;
