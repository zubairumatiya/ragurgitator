// DATA ACCESS LAYER — the authorization boundary.
//
// Per the Next 16 auth guide, proxy.ts is an OPTIMISTIC check only: it runs on
// every route including prefetches, reads the cookie, and redirects. It is not a
// security boundary and must never be the only thing standing between a request and
// someone's data.
//
// THIS is the boundary. Every Server Component and Server Action that touches user
// data calls withPageUser(); every route handler goes through withRequestConfig /
// withRequestUser. Both end up here, close to the data rather than at the edge.
//
// React's cache() memoizes per render pass, so a page whose layout, page and three
// leaf components each call requireUser() performs ONE getUser() round trip —
// what makes "check at every call site" affordable enough to actually do.
import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { serverSupabase } from "@/lib/auth/supabase";
import { withUser } from "@/lib/auth/userScope";
import { withDetachedQueue } from "@/lib/detached";

// The DTO — deliberately NOT the auth.users row. Supabase's user object carries
// app_metadata, identities, raw provider payloads and more; none of it belongs
// in a component tree, and returning the whole thing is how internal fields end
// up serialized into client props. Widen this only with fields a caller needs.
export type SessionUser = {
  id: string;
  email: string;
};

// Verified session or null. Does NOT redirect — for call sites that legitimately
// render both ways (the login page, a public landing page, a nav bar).
//
// Uses getUser(), never getSession(): getSession() trusts the cookie without
// verifying its signature with the auth server. See lib/auth/supabase.ts.
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await serverSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email };
});

// The one every protected call site uses. Redirects to /login when there's no
// valid session, so callers can treat the return value as guaranteed.
//
// No profile self-heal here: the 0046 trigger on auth.users creates the
// user_profiles row inside the same transaction as the signup, so "auth user
// with no profile" is unrepresentable for anyone created after that migration —
// including users added through the Supabase dashboard, which the trigger also
// covers. The upsert this used to do was only ever for pre-migration accounts,
// of which none remain.
export const requireUser = cache(async (): Promise<SessionUser> => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
});

// Route-handler variant: returns null instead of redirecting, so an API caller
// gets a 401 JSON body rather than a 307 to an HTML login page. A fetch() that
// silently follows a redirect and parses the login page as JSON is a genuinely
// confusing bug to chase, so the two paths stay separate on purpose.
export async function requireUserForApi(): Promise<SessionUser | null> {
  return getSessionUser();
}

// The standard 401 for route handlers, so every route spells it the same way.
export function unauthorizedJson(): Response {
  return Response.json({ error: "Not authenticated." }, { status: 401 });
}

// The page/action counterpart to withRequestConfig: require a session, then run
// `fn` inside the user scope so the store layer can read activeUserId().
//
// Server Components need this explicitly per page rather than once in a layout. A
// layout receives its children already-rendered as a prop, so a scope entered in
// the layout body does not enclose the page's own data fetching — the ALS context
// simply isn't active when the child renders.
//
// Also installs the detached queue. Page renders will mostly install one and flush
// nothing — they read — and that is the intended cost: flushDetached returns on an
// empty queue before touching the pool. Server Actions come through the same door,
// and after() runs even when the response ends in redirect() or a thrown error, so
// an action that queues work still flushes it.
export async function withPageUser<T>(fn: (user: SessionUser) => Promise<T>): Promise<T> {
  const user = await requireUser();
  return withDetachedQueue(user, after, () => withUser(user, () => fn(user)));
}
