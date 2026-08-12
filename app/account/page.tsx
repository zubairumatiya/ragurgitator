// ---------------------------------------------------------------------------
// The account page: identity, provider keys, and account deletion.
//
// A Server Component, so the key list is read through the DAL rather than an API
// route — the withPageUser() boundary is the authorization check and it sits
// right next to the query. listProviderKeys() returns DTOs with no ciphertext
// column in the SELECT at all, so what crosses into the client tree structurally
// cannot contain a credential.
//
// withPageUser, NOT a bare requireUser(). Both authenticate, but only
// withPageUser opens the transaction that carries the identity RLS reads (0051),
// and `sql` throws outside one. This page read as `requireUser()` +
// `listProviderKeys()` right up until 5b landed, which is why it was the last
// place still doing it.
//
// Reached by clicking the email in the sidebar footer. proxy.ts already protects
// it: only /login, /signup and /auth are public.
// ---------------------------------------------------------------------------
import { withPageUser } from "@/lib/auth/dal";
import {
  listProviderKeys,
  PROVIDER_IDS,
  PROVIDER_META,
  type ProviderKeyDto,
} from "@/lib/auth/providerKeys";
import { serverSupabase } from "@/lib/auth/supabase";
import { sql } from "@/lib/db";
import { mcpServerUrl } from "@/lib/mcp/metadata";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { DeleteAccountForm } from "@/app/components/DeleteAccountForm";
import { McpConnectionCard, type McpGrantDto } from "@/app/components/McpConnectionCard";
import { ProviderKeyRow } from "@/app/components/ProviderKeyRow";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const { user, keys, mcpEnabled } = await withPageUser(async (user) => ({
    user,
    keys: await listProviderKeys(user.id),
    mcpEnabled: await readMcpEnabled(user.id),
  }));

  const byProvider = new Map<string, ProviderKeyDto>(keys.map((k) => [k.provider, k]));

  // Read OUTSIDE the scope: this is a Supabase Auth call, not a store call, so
  // it has no business holding the RLS transaction open across a network round
  // trip. Skipped entirely when the feature is off — there is nothing to show.
  const { grants, grantsError } = mcpEnabled
    ? await readMcpGrants()
    : { grants: [], grantsError: null };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col px-6 py-10">
      {/* The way back. /account has no tab bar of its own, and "/" would dump
          you on your first open config rather than the one you left. */}
      <BackToConfigs />

      <h1 className="mt-6 text-lg font-medium">Account</h1>
      <p className="mt-1 text-sm text-zinc-500">{user.email}</p>

      <section className="mt-10">
        <h2 className="text-sm font-medium">Provider API keys</h2>
        <p className="mt-1 max-w-prose text-xs text-zinc-500">
          Your keys are encrypted before they are stored, under a key that never leaves Azure Key
          Vault — a copy of the database on its own reveals nothing. Because of that, we cannot
          show a key back to you after it is saved: only its last four characters. A key you have
          lost can be replaced, never recovered.
        </p>

        <div className="mt-4">
          {PROVIDER_IDS.map((id) => (
            <ProviderKeyRow
              key={id}
              provider={id}
              label={PROVIDER_META[id].label}
              role={PROVIDER_META[id].role}
              saved={byProvider.get(id)}
            />
          ))}
        </div>
      </section>

      <McpConnectionCard
        enabled={mcpEnabled}
        serverUrl={mcpServerUrl().href}
        grants={grants}
        grantsError={grantsError}
      />

      <section className="mt-12 rounded border border-red-200 p-4 dark:border-red-900/50">
        <h2 className="text-sm font-medium text-red-700 dark:text-red-400">Delete account</h2>
        <p className="mt-1 max-w-prose text-xs text-zinc-500">
          Permanently deletes your account and every provider key on it. This cannot be undone, and
          nothing here is recoverable afterwards — the stored keys become unopenable the moment the
          rows are gone.
        </p>
        <DeleteAccountForm />
      </section>
    </div>
  );
}

// Missing row → false, matching mcpEnabled() in lib/http/mcpScope.ts. The page
// and the endpoint must agree on what an absent profile means, or the card shows
// "on" for an account the server refuses.
async function readMcpEnabled(userId: string): Promise<boolean> {
  const rows = await sql<{ mcp_enabled: boolean }[]>`
    select mcp_enabled from user_profiles where id = ${userId}
  `;
  return rows[0]?.mcp_enabled ?? false;
}

// An unreachable grant list is REPORTED, not swallowed into an empty array. The
// overwhelmingly likely cause is that the OAuth server has not been enabled on
// the Supabase project yet, and "nothing is connected" would be a confident
// wrong answer to a question we could not actually ask.
async function readMcpGrants(): Promise<{ grants: McpGrantDto[]; grantsError: string | null }> {
  try {
    const supabase = await serverSupabase();
    const { data, error } = await supabase.auth.oauth.listGrants();
    if (error) {
      return {
        grants: [],
        grantsError:
          "Could not read connected agents. If you have just enabled MCP access, check that the " +
          "OAuth server is turned on for this Supabase project.",
      };
    }
    return {
      grants: (data ?? []).map((grant) => ({
        clientId: grant.client.id,
        clientName: grant.client.name || "Unnamed client",
        scopes: grant.scopes,
        grantedAt: grant.granted_at,
      })),
      grantsError: null,
    };
  } catch {
    return { grants: [], grantsError: "Could not read connected agents." };
  }
}
