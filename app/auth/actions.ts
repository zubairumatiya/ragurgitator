// Auth Server Actions — sign in, sign up, sign out.
//
// Server Actions (not Route Handlers) because these are form submissions that need
// to set cookies and then redirect, and because it keeps credentials off the client
// entirely: the password is posted as FormData and never held in React state.
//
// Shaped for React 19's useActionState — (prevState, formData) => state — so the
// form can render field errors and a pending state without client-side validation
// duplicating what's below.
"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

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

// Signup holds passwords to a real standard; signIn deliberately does NOT reuse
// this. Applying new-password rules at sign-in would reject valid older
// passwords, and worse, the rejection message would tell an attacker which
// rules a password does not satisfy.
const NewPassword = z
  .string()
  .min(8, "Use at least 8 characters.")
  // bcrypt — which Supabase uses — hashes only the first 72 BYTES and silently
  // ignores the rest. Rejecting here is honest; accepting would mean a password
  // whose tail does nothing.
  .max(72, "Use 72 characters or fewer.")
  .regex(/[a-zA-Z]/, "Include at least one letter.")
  .regex(/[0-9]/, "Include at least one number.");

const NewCredentials = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: NewPassword,
});

// Every failing rule at once. Fixing one problem only to be told about the next
// is the worst version of a password form.
function allIssues(error: z.ZodError): string {
  return [...new Set(error.issues.map((i) => i.message))].join(" ");
}

// Only same-origin relative paths may be used as a post-login destination.
// Without this check, ?next=https://evil.example turns the login form into an
// open redirect — a phishing primitive that looks like it came from your domain.
// "//host" is rejected too: it's protocol-relative and browsers treat it as
// absolute.
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
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
      // Where the confirmation email's link lands. Must be listed under
      // Authentication → URL Configuration → Redirect URLs in Supabase, or the
      // link silently falls back to the Site URL.
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002"}/auth/callback`,
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

export async function signOut(): Promise<void> {
  const supabase = await serverSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
