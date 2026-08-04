// ---------------------------------------------------------------------------
// Email-confirmation / OAuth landing route.
//
// Supabase emails a link back to here carrying a one-time `code`. Exchanging it
// establishes the session and sets the auth cookies — which is why this is a
// Route Handler and not a Server Component: only handlers and actions can write
// cookies, and the exchange is a write.
//
// A user arriving here has clicked a link in their mail client, so every failure
// path must land somewhere that explains itself rather than showing a raw error.
// ---------------------------------------------------------------------------
import { NextResponse, type NextRequest } from "next/server";

import { serverSupabase } from "@/lib/auth/supabase";

// Same rule as safeNext() in app/auth/actions.ts: a relative same-origin path
// only, or the confirmation link becomes an open redirect.
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  // Supabase reports link-level problems (expired, already used) as query params
  // rather than as an exchange failure, so they're checked before the exchange.
  const errorDescription = url.searchParams.get("error_description");
  if (errorDescription) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorDescription)}`, url.origin),
    );
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const supabase = await serverSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent("That confirmation link is invalid or has expired. Try signing in.")}`,
        url.origin,
      ),
    );
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
