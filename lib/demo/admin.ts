// THE SUPABASE ADMIN CLIENT — the one god-mode credential in this deployment,
// constructed here and nowhere else.
//
// app/account/actions.ts is explicit that account deletion goes through
// privilegedSql precisely so that "no Supabase service-role key is needed, and
// NOT introducing one matters: it is a permanent god-mode credential in the
// env". The demo is the case that finally needs one, so this file has to say
// what changed and what the alternatives were.
//
// WHY NOT postgres. Creating a guest means creating an `auth.users` row, and
// auth.users is Supabase's. Writing it directly would mean hand-rolling the
// password hash, the identity row and the confirmation columns against an
// undocumented schema that Supabase reserves the right to change — a login that
// silently stops working after a platform upgrade. 0046's header says we never
// write to auth.users, and this file does not either.
//
// WHY NOT ORDINARY SIGNUP. `auth.signUp()` sends a confirmation mail, and
// Supabase's built-in email provider is capped at TWO PER HOUR. That caps the
// demo at two visitors an hour, which is not a demo. `admin.createUser({
// email_confirm: true })` is the only call that mints a usable account without
// mail, and it requires the secret key.
//
// WHY NOT ANONYMOUS SIGN-IN. `signInAnonymously()` produces a user with no
// email, and getSessionUser() returns null without one (lib/auth/dal.ts) — every
// guest would bounce straight to /login. Widening the DTO means touching every
// site that reads user.email, the completion-email path included.
//
// CONTAINMENT, since the credential exists now:
//
//   • It is read only by this module, and this module exports exactly three calls
//     — create a guest, delete guests, and mint the one snapshot account an
//     operator publishes into. Nothing here can read another user's data,
//     because nothing here queries.
//   • It is server-only and never NEXT_PUBLIC_.
//   • Absent it, demoEnabled() is false and the whole feature 404s, so a
//     deployment that does not run the demo does not hold the key.
import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// `sb_secret_…`, the successor to the legacy service_role JWT — same reasoning
// as the publishable/anon pair in lib/auth/supabase.ts, and the same fallback
// for projects created before the new format.
function secretKey(): string | undefined {
  return (
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    undefined
  );
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = secretKey();
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set. It is required only by the guest demo " +
        "(lib/demo/admin.ts); without it demoEnabled() is false and no caller " +
        "should have reached this point.",
    );
  }
  // No session persistence, no auto-refresh, no URL detection: this client
  // authenticates with a static secret and must never acquire an ambient
  // session. Same posture as tokenSupabase() in lib/auth/supabase.ts.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type GuestCredentials = { id: string; email: string; password: string };

// Mint a confirmed guest account and hand back the password, because the caller
// immediately signs in with it to get a cookie session. The password is used
// once, within the same request, and stored nowhere.
//
// `@demo.invalid` is reserved by RFC 2606 and can never resolve, which is the
// point: a guest address must be undeliverable BY CONSTRUCTION so that a
// notification aimed at one is a bug we can see rather than a bounce against the
// Resend account's sender reputation. lib/demo/guest.ts suppresses those sends;
// this makes the failure mode harmless even if one slips through.
export async function createGuestAuthUser(): Promise<GuestCredentials> {
  const email = `guest-${crypto.randomUUID()}@demo.invalid`;
  const password = crypto.randomUUID() + crypto.randomUUID();

  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    // Skips the confirmation mail entirely — see the header. Without this the
    // account exists but cannot sign in until a mail nobody will ever receive is
    // clicked.
    email_confirm: true,
    user_metadata: { guest: true },
  });

  if (error || !data.user) {
    throw new Error(`demo: could not create guest account — ${error?.message ?? "no user returned"}`);
  }

  // The 0046 trigger created the user_profiles row inside the same transaction,
  // so there is nothing to self-heal and no window in which a guest exists
  // without a profile.
  return { id: data.user.id, email, password };
}

// THE SNAPSHOT ACCOUNT — minted once, by an operator, from
// scripts/demo-snapshot.ts. Not a guest: no `guest: true`, no expiry, and it
// keeps whatever real address is given so the ordinary password-reset mail can
// reach it. That address is the only way back into it, which is why it must not
// be an @demo.invalid one.
//
// Same `email_confirm` as a guest, for a different reason: the confirmation mail
// is not rate-limiting anything here, but an account that cannot sign in until
// someone clicks a link is a half-provisioned account, and a publish target that
// exists but is unusable is exactly the state this script should not create.
//
// It holds NO provider key. Guests get the Voyage key sealed per guest
// (lib/demo/provision.ts) and publishing spends nothing, so the snapshot account
// is a workspace with no credential attached to it — which is the reason it can
// be a permanent, unattended account at all.
export async function createSnapshotAccount(email: string, password: string): Promise<string> {
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(
      `demo: could not create the snapshot account — ${error?.message ?? "no user returned"}`,
    );
  }
  return data.user.id;
}
