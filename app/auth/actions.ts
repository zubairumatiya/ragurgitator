// ---------------------------------------------------------------------------
// Auth Server Actions — sign in, sign up, sign out.
//
// Server Actions (not Route Handlers) because these are form submissions that
// need to set cookies and then redirect, and because it keeps credentials off
// the client entirely: the password is posted as FormData to the server and is
// never held in React state.
//
// Shaped for React 19's useActionState — (prevState, formData) => state — so the
// form can render field errors and a pending state without any client-side
// validation logic duplicating what's below.
// ---------------------------------------------------------------------------
"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { serverSupabase } from "@/lib/auth/supabase";

export type AuthState = {
  error?: string;
  // Set after signup when Supabase requires email confirmation — the form swaps
  // to a "check your inbox" state rather than pretending the user is signed in.
  notice?: string;
};

// Validated server-side, always. Client-side constraints (`required`, `type=
// email`) are a UX affordance and nothing more — anything can POST to a Server
// Action, so this is the only check that counts.
const Credentials = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  // Supabase's own floor is 6; 8 is a cheap improvement and the error names the
  // rule rather than making the user guess.
  password: z.string().min(8, "Password must be at least 8 characters."),
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

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = Credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const supabase = await serverSupabase();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // Deliberately generic, and identical for "no such user" and "wrong
    // password". Distinguishing them turns the login form into an account
    // enumeration oracle.
    return { error: "Incorrect email or password." };
  }

  redirect(safeNext(formData.get("next")?.toString()));
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = Credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
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
    return { error: error.message };
  }

  // With email confirmation ON (Supabase's default), signUp returns a user but
  // no session. Reporting "check your inbox" without revealing whether the
  // address was already registered keeps the same anti-enumeration posture as
  // signIn — Supabase deliberately returns a normal-looking response for an
  // existing address.
  if (!data.session) {
    return { notice: "Check your email for a confirmation link to finish signing up." };
  }

  redirect(safeNext(formData.get("next")?.toString()));
}

export async function signOut(): Promise<void> {
  const supabase = await serverSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
