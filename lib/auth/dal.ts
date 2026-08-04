// ---------------------------------------------------------------------------
// DATA ACCESS LAYER — the authorization boundary.
//
// Per the Next 16 auth guide (node_modules/next/dist/docs/01-app/02-guides/
// authentication.md), proxy.ts is an OPTIMISTIC check only: it runs on every
// route including prefetches, reads the cookie, and redirects. It is not a
// security boundary and must never be the only thing standing between a request
// and someone's data.
//
// THIS is the boundary. Every Server Component, Server Action and Route Handler
// that touches user data calls requireUser() (or requireConfigAccess() once
// ownership lands in 0045), close to the data rather than at the edge.
//
// React's cache() memoizes per render pass, so a page whose layout, page, and
// three leaf components each call requireUser() performs ONE getUser() round
// trip. That's what makes "check at every call site" affordable enough to
// actually do — the guide's recommended pattern.
// ---------------------------------------------------------------------------
import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { sql } from "@/lib/db";
import { serverSupabase, supabaseConfigured } from "@/lib/auth/supabase";

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
  // Matches proxy.ts: with Supabase unconfigured there is no session to read, so
  // report "nobody is signed in" rather than throwing. Keeps GET /api/auth/me a
  // clean 401 instead of a 500, which is what the sidebar's account footer
  // expects when it decides not to render.
  if (!supabaseConfigured()) return null;

  const supabase = await serverSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email };
});

// The one every protected call site uses. Redirects to /login when there's no
// valid session, so callers can treat the return value as guaranteed.
export const requireUser = cache(async (): Promise<SessionUser> => {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  await ensureProfile(user);
  return user;
});

// Self-healing profile row. The 0044 trigger creates one for every auth.users
// insert, so this is normally a no-op — it exists because a user created OUTSIDE
// the trigger's reach (via the Supabase dashboard, or before the migration
// applied) would otherwise hit a foreign-key violation the first time they
// created a corpus, with an error message pointing nowhere useful.
//
// Cached per render pass alongside requireUser, so it costs one upsert per
// request at most, and Postgres skips the write entirely on conflict.
const ensureProfile = cache(async (user: SessionUser): Promise<void> => {
  await sql`
    insert into user_profiles (id, email)
    values (${user.id}, ${user.email})
    on conflict (id) do nothing
  `;
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
