// ACTIVE USER — request-scoped identity.
//
// The deliberate twin of lib/rag/activeConfig.ts, for the same reason: the store
// layer runs many levels below the route handler, and threading a userId through
// every call site would mean touching several hundred signatures to add one
// predicate to each query. AsyncLocalStorage carries it instead, so
// `select … where user_id = ${activeUserId()}` works at any depth.
//
// Entered in exactly four places, and nowhere else:
//
//   1. lib/http/configScope.ts   — withRequestConfig / withRequestUser (routes)
//   2. lib/auth/dal.ts           — withPageUser (Server Components, actions)
//   3. lib/http/mcpScope.ts      — withMcpUser (the MCP endpoint, /api/mcp)
//   4. scripts/*                 — from SCRIPT_USER_ID
//
// Keeping that list short is what makes the scope auditable: every entry point has
// already verified a session (or is an operator running a script), so code inside a
// scope can treat activeUser() as authenticated fact.
//
// The third is the odd one out: its credential is a BEARER TOKEN rather than a
// cookie, verified against the project JWKS before the scope opens. The
// authenticated-fact guarantee is unchanged — only the proof's origin differs —
// but a token, unlike a cookie, is presented explicitly, so withMcpUser takes the
// user as an argument instead of resolving it from ambient request state.
//
// The first three also own the DETACHED QUEUE (lib/detached.ts): they install it
// and hand Next's `after` the flush that drains it once the response is out, and
// the flush re-enters this scope from the RequestUser they captured. Scripts do
// not, so telemetry there runs inline — which is why detached() has to work both
// ways. A deferred write has to carry the ACTIVE CONFIG too: nine of the telemetry
// sites resolve their config_id from it, and losing it makes them silently write
// nothing.
//
// Streaming routes need care. lib/http/ndjson.ts runs its producer after the route
// handler has returned, so it re-enters this scope itself rather than inheriting it
// — the async context AsyncResource.bind restores carries a transaction that has
// already committed. See the ordering note in that file; it is not a detail you can
// rearrange safely.
import { AsyncLocalStorage } from "node:async_hooks";

import { withUserTransaction } from "@/lib/db";

// Mirrors SessionUser in lib/auth/dal.ts rather than importing it: dal.ts is
// "server-only" and pulls in the Supabase client, while this module is imported
// by the store layer and by scripts, neither of which should drag that in.
export type RequestUser = {
  id: string;
  email: string;
};

const store = new AsyncLocalStorage<RequestUser>();

// Run `fn` with `user` as the active user. Everything awaited inside the same
// async chain — including deep store calls — sees it via activeUser().
//
// As of 0051 this also opens the database transaction that carries the identity
// RLS checks (lib/db.ts). The two are deliberately the same boundary: a scope
// that set activeUser() without setting the GUC would pass every store-layer
// predicate and be denied every row, which is a confusing way to learn that the
// two identities drifted. Nesting is free — withUserTransaction reuses an
// already-open transaction for the same user.
export function withUser<T>(user: RequestUser, fn: () => Promise<T>): Promise<T> {
  return store.run(user, () => withUserTransaction(user.id, fn));
}

// The active user for the current scope. Throws when called outside withUser,
// exactly like activeConfig() does.
//
// Throwing is the security-relevant part. The alternative — returning null and
// letting callers decide — means one forgotten null check turns into a query
// with no user_id predicate, i.e. a silent cross-tenant read. A store call that
// escaped its request scope is a programming error, and it should fail closed
// and loudly rather than quietly widen to everyone's rows.
export function activeUser(): RequestUser {
  const user = store.getStore();
  if (!user) {
    throw new Error("activeUser() called outside a withUser() scope.");
  }
  return user;
}

// Sugar for the overwhelmingly common case — a SQL predicate needs the id only.
export function activeUserId(): string {
  return activeUser().id;
}
