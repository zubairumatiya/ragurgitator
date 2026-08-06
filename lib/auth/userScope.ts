// ---------------------------------------------------------------------------
// ACTIVE USER — request-scoped identity.
//
// The deliberate twin of lib/rag/activeConfig.ts, and it exists for the same
// reason: the store layer runs many levels below the route handler, and
// threading a userId through every call site would mean touching several hundred
// signatures to add one predicate to each query. AsyncLocalStorage carries it
// instead, so `select … where user_id = ${activeUserId()}` works at any depth.
//
// Entered in exactly three places, and nowhere else:
//
//   1. lib/http/configScope.ts   — withRequestConfig / withRequestUser (routes)
//   2. lib/auth/dal.ts           — withPageUser (Server Components, actions)
//   3. scripts/*                 — from SCRIPT_USER_ID, see the Phase 7 note in
//                                  docs/user-accounts-plan.md
//
// Keeping that list short is what makes the scope auditable: every entry point
// has already verified a session (or is an operator running a script), so code
// inside a scope can treat activeUser() as authenticated fact.
//
// Streaming routes need no special handling — lib/http/ndjson.ts binds the async
// context with AsyncResource.bind before the stream producer runs, which carries
// this scope along with the config scope.
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks";

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
export function withUser<T>(user: RequestUser, fn: () => Promise<T>): Promise<T> {
  return store.run(user, fn);
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

// Whether a scope is active, WITHOUT throwing. For the rare call site that is
// legitimately reachable both inside and outside a request (the batch poller's
// per-job re-entry). Not an escape hatch for stores — if you find yourself
// reaching for this to avoid a throw, the fix is to enter the scope earlier.
export function hasActiveUser(): boolean {
  return store.getStore() !== undefined;
}
