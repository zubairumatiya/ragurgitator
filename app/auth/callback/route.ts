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
//
// THREE MAIL TYPES ARRIVE HERE, not one: signup confirmation, and now password
// recovery (type=recovery, sent by requestPasswordReset). Recovery differs in
// three ways, each marked below — it must spend its token even for a signed-in
// visitor, it sets the recovery-intent cookie that /auth/reset requires, and its
// failure copy sends the user to /auth/forgot-password rather than /login, since
// being unable to sign in is the reason they are here.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { setRecoveryIntent } from "@/lib/auth/recoveryIntent";
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

// The same dead-token situation, told to someone who came from a RESET mail. The
// confirmation wording above would answer a question they did not ask — their
// address was confirmed long ago; what they want to know is that this particular
// link is spent and where to get another.
const RECOVERY_DEAD =
  "That password reset link has already been used or has expired. Request a new one below.";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));

  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const code = url.searchParams.get("code");

  // Read before any branch below needs it: recovery is the one flow where a link
  // must be spent even for a visitor who already has a session.
  const isRecovery = type === "recovery";

  const toLogin = (error?: string) =>
    NextResponse.redirect(
      new URL(error ? `/login?error=${encodeURIComponent(error)}` : "/login", url.origin),
    );

  // A dead recovery link belongs at the form that issues a new one, not at the
  // sign-in form — the user cannot sign in, which is why they are here.
  const toForgot = (error: string) =>
    NextResponse.redirect(
      new URL(`/auth/forgot-password?error=${encodeURIComponent(error)}`, url.origin),
    );

  // ALREADY SIGNED IN — check before touching any token. Re-clicking the link
  // from the inbox after signing in is the most common way to land here with a
  // spent token, and showing a signed-in user an authentication error for a step
  // they already completed is pure noise. Send them where the link pointed.
  //
  // RECOVERY IS EXEMPT. Skipping the token for a signed-in visitor is harmless
  // for a confirmation link — the address is confirmed either way — but it is
  // wrong for recovery: the token would go unspent, no recovery-intent cookie
  // would be set, and /auth/reset would turn them away for arriving without the
  // proof of mailbox access this request was carrying all along.
  const supabase = await serverSupabase();
  const { data: existing } = await supabase.auth.getUser();
  if (existing.user && !isRecovery) {
    return NextResponse.redirect(new URL(next, url.origin));
  }

  // Supabase reports link-level problems (expired, already used) as query params
  // rather than as a verification failure, so they are checked before the token.
  // Its own error_description reads "Email link is invalid or has expired",
  // which is replaced here — by this point we know the user is NOT signed in, so
  // "already used" is the honest and more likely reading for a link that was
  // just delivered.
  if (url.searchParams.get("error_description") || url.searchParams.get("error")) {
    return isRecovery ? toForgot(RECOVERY_DEAD) : toLogin(ALREADY_DONE);
  }

  // Where a verified link lands, plus the recovery-intent cookie when one is
  // owed. The cookie has to be set on the RESPONSE, which is why this is built
  // here rather than returned straight from each branch.
  const onward = () => {
    const response = NextResponse.redirect(new URL(next, url.origin));
    if (isRecovery) setRecoveryIntent(response);
    return response;
  };

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return isRecovery ? toForgot(RECOVERY_DEAD) : toLogin(ALREADY_DONE);
    return onward();
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // A failure here is usually the missing-code-verifier case described in the
    // header rather than a bad link, and the address is confirmed either way, so
    // this must NOT claim the link was broken.
    if (error) {
      // For recovery there is no equivalent consolation: without the exchange
      // there is no session, so there is nothing to reset with. The honest
      // instruction is to request another link — and to do it from the browser
      // that will open it, which is what avoids a repeat.
      if (isRecovery) {
        return toForgot(
          "This browser couldn't open that reset link. Request a new one here, then open it in this same browser.",
        );
      }
      return toLogin(
        "Your email is confirmed, but this browser couldn't finish signing you in automatically. Sign in below.",
      );
    }
    return onward();
  }

  // No token of any kind — a bare visit to /auth/callback, or a link mangled in
  // transit. Nothing to report; just show the form.
  return toLogin();
}
