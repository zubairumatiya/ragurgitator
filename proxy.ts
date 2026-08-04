// ---------------------------------------------------------------------------
// PROXY — Next 16's renamed Middleware (node_modules/next/dist/docs/01-app/
// 01-getting-started/16-proxy.md). Root-level, one per project.
//
// Two jobs, and deliberately nothing else:
//
//   1. REFRESH the Supabase session. Access tokens are short-lived; without a
//      refresh on each navigation the user is silently logged out mid-session.
//      This has to happen somewhere that can write cookies to the RESPONSE,
//      which Server Components cannot do — hence here.
//
//   2. OPTIMISTIC redirect of cookie-less visitors to /login.
//
// It is NOT an authorization boundary. The Next auth guide is explicit that
// proxy runs on every route including prefetches, so it must stay cheap and must
// never be the only check. Real authorization is lib/auth/dal.ts, called next to
// the data. If this file were deleted, the app should still be secure — only
// less pleasant to use.
// ---------------------------------------------------------------------------
import { NextResponse, type NextRequest } from "next/server";

import { proxySupabase } from "@/lib/auth/supabase";

// Reachable without a session. Everything else redirects.
const PUBLIC_PREFIXES = ["/login", "/signup", "/auth"];

const isPublic = (path: string) => PUBLIC_PREFIXES.some((p) => path.startsWith(p));

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Supabase hands back rotated cookies through setAll. They must be written to
  // BOTH the request (so the getUser() call below sees the new token) and a
  // freshly-constructed response (so the browser receives it). Rebuilding the
  // response rather than mutating the old one is required by @supabase/ssr —
  // the docs call out random logouts and phantom session loss as the symptom
  // when this is done wrong.
  const supabase = proxySupabase(request, (cookiesToSet) => {
    for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
    response = NextResponse.next({ request });
    for (const { name, value, options } of cookiesToSet) {
      response.cookies.set(name, value, options);
    }
    return response;
  });

  // getUser(), not getSession() — this call is what actually revalidates the
  // token with the auth server and triggers the refresh. See lib/auth/supabase.ts.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // API routes: refresh the session, but NEVER redirect. A fetch() that follows
  // a 307 to /login and then parses HTML as JSON produces an error message that
  // has nothing to do with the actual problem. Route handlers return their own
  // 401 via requireUserForApi() + unauthorizedJson().
  if (path.startsWith("/api")) return response;

  if (!user && !isPublic(path)) {
    const login = new URL("/login", request.nextUrl);
    // Preserve where they were headed so login can bounce them back.
    if (path !== "/") login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  // A signed-in user has no business on the login/signup forms.
  if (user && (path.startsWith("/login") || path.startsWith("/signup"))) {
    return NextResponse.redirect(new URL("/", request.nextUrl));
  }

  return response;
}

export const config = {
  // Everything except static assets and image optimization. The auth guide
  // recommends proxy run on all routes; the exclusions here are files that can
  // never carry a session and would only add latency.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
