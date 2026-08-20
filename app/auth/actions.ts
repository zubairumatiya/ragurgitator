// Auth Server Actions — sign in, sign up, sign out, and password recovery.
//
// Server Actions (not Route Handlers) because these are form submissions that need
// to set cookies and then redirect, and because it keeps credentials off the client
// entirely: the password is posted as FormData and never held in React state.
//
// Shaped for React 19's useActionState — (prevState, formData) => state — so the
// form can render field errors and a pending state without client-side validation
// duplicating what's below.
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth/dal";
import { allIssues, NewPassword } from "@/lib/auth/passwordPolicy";
import { RECOVERY_COOKIE } from "@/lib/auth/recoveryIntent";
import { revokeOtherSessions } from "@/lib/auth/sessions";
import { serverSupabase } from "@/lib/auth/supabase";

export type AuthState = {
  error?: string;
  // Echoed back so a rejected submit can refill the email field. React 19 resets
  // an uncontrolled form after every action, so without this the user retypes
  // their address every time they fat-finger a password.
  //
  // The PASSWORD is deliberately never echoed. Round-tripping it would put the
  // plaintext into the RSC payload and then into a `value` attribute in the DOM
  // — visible in devtools, and capturable by any extension with page access.
  // Refilling the email is the part that actually saves typing anyway.
  email?: string;
};

// Validated server-side, always. Client-side constraints (`required`, `type=
// email`, `minLength`) are a UX affordance and nothing more — anything can POST
// to a Server Action, so this is the only check that counts.
const Credentials = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

// NewPassword and allIssues now live in lib/auth/passwordPolicy.ts: this file is
// "use server", so it can only export async functions, and the reset and
// change-password flows both need the same rules.
const NewCredentials = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: NewPassword,
});

// Just the address, for the form that has nothing else on it.
const EmailOnly = z.object({
  email: z.string().trim().email("Enter a valid email address."),
});

// Only same-origin relative paths may be used as a post-login destination.
// Without this check, ?next=https://evil.example turns the login form into an
// open redirect — a phishing primitive that looks like it came from your domain.
// "//host" is rejected too: it's protocol-relative and browsers treat it as
// absolute.
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

// The origin every emailed link is built from. Must also be listed under
// Authentication → URL Configuration → Redirect URLs in Supabase, or the link
// silently falls back to the project's Site URL. Defaults to the dev port.
function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = formData.get("email")?.toString() ?? "";
  const parsed = Credentials.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, email };
  }

  const supabase = await serverSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Deliberately generic, and identical for "no such user" and "wrong
    // password". Distinguishing them turns the login form into an account
    // enumeration oracle.
    //
    // One exception is worth surfacing, because it is the user's own account
    // and the fix is a different action entirely: an unconfirmed address fails
    // here forever with no hint of why.
    if (error.code === "email_not_confirmed") {
      return {
        error: "This email hasn't been confirmed yet. Check your inbox for the confirmation link.",
        email,
      };
    }
    return { error: "Incorrect email or password.", email };
  }

  redirect(safeNext(formData.get("next")?.toString()));
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = formData.get("email")?.toString().trim() ?? "";
  const parsed = NewCredentials.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) {
    return { error: allIssues(parsed.error), email };
  }

  const supabase = await serverSupabase();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      // Where the confirmation email's link lands.
      emailRedirectTo: `${siteUrl()}/auth/callback`,
    },
  });

  if (error) {
    return { error: error.message, email };
  }

  // With email confirmation ON, signUp returns a user but no session, so there is
  // nothing to sign in to yet. Redirecting to a dedicated page rather than
  // re-rendering the form with a notice means the destination is a real URL: it
  // survives a refresh, it can't be mistaken for "the form didn't submit", and the
  // fields are gone so there is no half-filled signup inviting a second attempt.
  //
  // The address is passed along only so the page can name it. Supabase returns this
  // same shape for an address that is ALREADY registered, which is what keeps signup
  // from being an account-enumeration oracle — so the page must stay worded as "if
  // that address is new, a link is on its way."
  if (!data.session) {
    redirect(`/signup/check-email?email=${encodeURIComponent(parsed.data.email)}`);
  }

  redirect(safeNext(formData.get("next")?.toString()));
}

// Step one of recovery: post an address, get a link in the mail.
//
// The reply is IDENTICAL whether or not that address has an account — same
// redirect, same page, same wording. Anything else turns this form into the
// account-enumeration oracle that signIn and signUp both go out of their way not
// to be: an attacker with a list of addresses could sort it into customers and
// non-customers by watching which ones produce an error.
export async function requestPasswordReset(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = formData.get("email")?.toString().trim() ?? "";
  const parsed = EmailOnly.safeParse({ email });
  // The one thing worth reporting: a malformed address is the user's typo, not a
  // fact about who is registered here.
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, email };
  }

  const supabase = await serverSupabase();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    // Only consulted if the mail template still uses {{ .ConfirmationURL }}. Once
    // it is switched to {{ .TokenHash }} the template carries its own path — but
    // both must land on /auth/callback, so this stays correct either way.
    redirectTo: `${siteUrl()}/auth/callback?next=/auth/reset`,
  });

  // Swallowed on purpose, and logged instead. A real failure here (SMTP down,
  // rate limit reached) is ours to notice, and surfacing it to the form would
  // leak the distinction the identical-reply rule above exists to hide.
  if (error) {
    console.error("resetPasswordForEmail failed", error);
  }

  redirect(`/auth/forgot-password/check-email?email=${encodeURIComponent(parsed.data.email)}`);
}

// Step two: the recovery session is live, so set the new password.
//
// No current-password check here, deliberately — the user is here BECAUSE they
// cannot supply it, and the mail round trip is what stands in its place. That is
// why the recovery-intent cookie is mandatory: without it, "has a session" would
// be the only gate, and every signed-in session would pass it. See
// lib/auth/recoveryIntent.ts.
export async function setNewPassword(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = NewPassword.safeParse(formData.get("password"));
  if (!parsed.success) {
    return { error: allIssues(parsed.error) };
  }

  const jar = await cookies();
  if (!jar.get(RECOVERY_COOKIE)) {
    return {
      error:
        "This password reset has expired. Request a new link and open it from your email again.",
    };
  }

  // Bare requireUser, not withPageUser: nothing below touches the store, so there
  // is no reason to open the RLS transaction.
  await requireUser();
  const supabase = await serverSupabase();

  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) {
    return { error: error.message };
  }

  await revokeOtherSessions(supabase);

  // Spent. One link, one password change — leaving it armed would let a second
  // visit to /auth/reset change the password again without another mail.
  jar.delete(RECOVERY_COOKIE);

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await serverSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
