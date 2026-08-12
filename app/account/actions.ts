// Account Server Actions — save / delete a provider key, delete the account.
//
// Server Actions rather than Route Handlers for the same reason as the auth forms:
// the API key is posted as FormData and never held in React state, so it exists on
// the client only as the contents of a write-only <input> discarded on submit.
//
// EVERY action re-derives the user from the session. The user id is never accepted
// from the form — a hidden field is caller-controlled input, and trusting one here
// would let anyone write keys into anyone's row.
//
// The two key actions use withPageUser rather than a bare requireUser(): as of
// 0051 authenticating is no longer enough, because `sql` also needs the
// transaction carrying the identity the RLS policies read. deleteAccount is the
// exception and stays on requireUser() — it touches only privilegedSql, which
// deliberately runs outside any scope.
//
// Form validation happens BEFORE entering the scope, so a malformed submission
// never opens a transaction it has no use for.
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireUser, withPageUser } from "@/lib/auth/dal";
import { serverSupabase } from "@/lib/auth/supabase";
import { deleteProviderKey, isProviderId, saveProviderKey } from "@/lib/auth/providerKeys";
import { invalidateProviderClients } from "@/lib/llm/client";
import { privilegedSql, sql } from "@/lib/db";

export type KeyFormState = {
  error?: string;
  // Which provider the message belongs to, so a page showing four forms can put
  // the result under the right one instead of at the top.
  provider?: string;
  savedProvider?: string;
};

export async function saveKey(_prev: KeyFormState, formData: FormData): Promise<KeyFormState> {
  const provider = formData.get("provider")?.toString() ?? "";
  if (!isProviderId(provider)) {
    return { error: "Unknown provider." };
  }

  const apiKey = formData.get("apiKey")?.toString() ?? "";
  // saveProviderKey verifies the key against the provider before writing, so the
  // scope's transaction is held across a network round trip. That is the same
  // trade the chat path already makes, and this is a once-per-rotation action.
  const { result, userId } = await withPageUser(async (user) => ({
    result: await saveProviderKey(user.id, provider, apiKey),
    userId: user.id,
  }));
  if (!result.ok) {
    return { error: result.message, provider };
  }

  // Drop any client built from the PREVIOUS key. Without this a rotation would
  // keep billing the old credential for up to the 60s client TTL, and the user
  // would see a settings page that says "saved" while their next request still
  // fails on the key they just replaced.
  invalidateProviderClients(userId);
  revalidatePath("/account");
  return { savedProvider: provider, provider };
}

export async function deleteKey(_prev: KeyFormState, formData: FormData): Promise<KeyFormState> {
  const provider = formData.get("provider")?.toString() ?? "";
  if (!isProviderId(provider)) {
    return { error: "Unknown provider." };
  }

  const userId = await withPageUser(async (user) => {
    await deleteProviderKey(user.id, provider);
    return user.id;
  });
  // A deleted key must stop working immediately, not when the cache expires.
  invalidateProviderClients(userId);
  revalidatePath("/account");
  return { provider };
}

// MCP ACCESS — the kill switch, and per-client revocation.
//
// Two different kinds of "off", and both exist because they fail differently.
// setMcpEnabled is the account-wide switch (0059): it takes effect on the very
// next request, needs no knowledge of which clients exist, and is what to reach
// for when you don't know what leaked. revokeMcpGrant is surgical — it deletes ONE
// client's sessions and invalidates its refresh tokens at Supabase.
//
// Neither takes an id from the form for the user. revokeMcpGrant does take a
// clientId, which is safe because Supabase scopes the revocation to the caller's
// own grants: a forged client id revokes nothing.
export type McpFormState = {
  error?: string;
  saved?: boolean;
};

export async function setMcpEnabled(
  _prev: McpFormState,
  formData: FormData,
): Promise<McpFormState> {
  // An unchecked checkbox submits nothing at all, so absence IS false — this
  // reads the form exactly as the browser sends it rather than requiring a
  // hidden companion field.
  const enabled = formData.get("mcpEnabled") === "on";

  try {
    await withPageUser(async (user) => {
      await sql`update user_profiles set mcp_enabled = ${enabled} where id = ${user.id}`;
    });
  } catch {
    return { error: "Could not update MCP access. Try again." };
  }

  revalidatePath("/account");
  return { saved: true };
}

export async function revokeMcpGrant(
  _prev: McpFormState,
  formData: FormData,
): Promise<McpFormState> {
  const clientId = formData.get("clientId")?.toString() ?? "";
  if (!clientId) return { error: "Missing client." };

  // Authenticate only — the revocation itself is scoped by Supabase to this
  // session's user, and no store call is made, so there is no scope to enter.
  await requireUser();

  const supabase = await serverSupabase();
  const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
  if (error) {
    return { error: error.message || "Could not disconnect that client." };
  }

  // Revoking the grant stops Supabase minting new tokens for the client and
  // kills its sessions, but an access token it ALREADY holds stays
  // signature-valid until it expires — getClaims verifies a signature, not
  // session liveness. Nothing here can shorten that, which is the honest reason
  // the account-wide switch above exists alongside this one.
  revalidatePath("/account");
  return { saved: true };
}

// ACCOUNT DELETION
//
// Deletes the auth.users row directly over our own pooled connection — one of only
// three callers of privilegedSql. `auth.users` is owned by supabase_auth_admin
// with DELETE granted to `postgres`, and 0051 deliberately did NOT re-grant that
// to `rag_app`. Going through `postgres` also means no Supabase service-role key
// is needed, and NOT introducing one matters: it is a permanent god-mode
// credential in the env.
//
// One statement is enough because the cascade chain is already declared:
//
//   auth.users → user_profiles (0046, on delete cascade)
//              → user_provider_keys (0048, on delete cascade)
//
// so the sealed keys go with the account. The Key Vault KEK is untouched: it is
// shared across all users, and the per-row DEKs it wrapped are gone, which makes
// the ciphertext permanently unopenable regardless.
//
// Sign-out happens FIRST. Reversing the order leaves a cookie whose user no longer
// exists, and every subsequent request pays a failed getUser() round trip before
// landing on /login.
export async function deleteAccount(): Promise<void> {
  const user = await requireUser();

  const supabase = await serverSupabase();
  await supabase.auth.signOut();

  await privilegedSql`delete from auth.users where id = ${user.id}`;

  redirect("/login?deleted=1");
}
