// Email-confirmation / OAuth landing route.
//
// A user arriving here has clicked a link in their mail client, so every failure
// path must land somewhere that explains itself rather than showing a raw error. A
// Route Handler and not a Server Component because establishing the session writes
// cookies.
//
// TWO LINK SHAPES ARE ACCEPTED, and the order matters:
//
//   token_hash + type   verifyOtp(). What Supabase's SSR guide recommends for email
//                       links, and the one that works when the link is opened
//                       somewhere other than the browser that signed up.
//   code                exchangeCodeForSession(). The PKCE flow.
//
// Why token_hash is preferred: PKCE stashes a code VERIFIER in a cookie at signup
// and requires it back at exchange. Mail clients routinely open links in a different
// browser, where that cookie does not exist — so exchangeCodeForSession fails even
// though the link was valid, and Supabase's verify endpoint has ALREADY marked the
// address confirmed by the time we see it. That combination produced the old
// "invalid or has expired" message on a link that had just worked.
//
// Both are handled so this route keeps working before and after the email template
// is switched to {{ .TokenHash }}.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { serverSupabase } from "@/lib/auth/supabase";

// Same rule as safeNext() in app/auth/actions.ts: a relative same-origin path
// only, or the confirmation link becomes an open redirect.
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

// The one-time token is spent on first use, so a second click ALWAYS fails no
// matter how healthy the link was. Telling that user their link is "invalid or
// expired" is technically true and completely useless — they already confirmed,
// and the only thing they need to know is that there is nothing left to do.
const ALREADY_DONE = "That link has already been used. Your email is confirmed — sign in below.";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));

  const toLogin = (error?: string) =>
    NextResponse.redirect(
      new URL(error ? `/login?error=${encodeURIComponent(error)}` : "/login", url.origin),
    );

  // ALREADY SIGNED IN — check before touching any token. Re-clicking the link
  // from the inbox after signing in is the most common way to land here with a
  // spent token, and showing a signed-in user an authentication error for a step
  // they already completed is pure noise. Send them where the link pointed.
  const supabase = await serverSupabase();
  const { data: existing } = await supabase.auth.getUser();
  if (existing.user) {
    return NextResponse.redirect(new URL(next, url.origin));
  }

  // Supabase reports link-level problems (expired, already used) as query params
  // rather than as a verification failure, so they are checked before the token.
  // Its own error_description reads "Email link is invalid or has expired",
  // which is replaced here — by this point we know the user is NOT signed in, so
  // "already used" is the honest and more likely reading for a link that was
  // just delivered.
  if (url.searchParams.get("error_description") || url.searchParams.get("error")) {
    return toLogin(ALREADY_DONE);
  }

  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return toLogin(ALREADY_DONE);
    return NextResponse.redirect(new URL(next, url.origin));
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // A failure here is usually the missing-code-verifier case described in the
    // header rather than a bad link, and the address is confirmed either way, so
    // this must NOT claim the link was broken.
    if (error) {
      return toLogin(
        "Your email is confirmed, but this browser couldn't finish signing you in automatically. Sign in below.",
      );
    }
    return NextResponse.redirect(new URL(next, url.origin));
  }

  // No token of any kind — a bare visit to /auth/callback, or a link mangled in
  // transit. Nothing to report; just show the form.
  return toLogin();
}
