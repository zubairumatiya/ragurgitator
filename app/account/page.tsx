// The account page: identity, provider keys, and account deletion.
//
// A Server Component, so the key list is read through the DAL rather than an API
// route — the withPageUser() boundary is the authorization check and it sits right
// next to the query. listProviderKeys() returns DTOs with no ciphertext column in
// the SELECT at all, so what crosses into the client tree structurally cannot
// contain a credential.
//
// withPageUser, NOT a bare requireUser(). Both authenticate, but only withPageUser
// opens the transaction that carries the identity RLS reads (0051), and `sql` throws
// outside one.
import Link from "next/link";

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
import { listGrants as listWriteGrants } from "@/lib/mcp/writeGrant";
import { type WriteGrant, grantIsLive } from "@/lib/mcp/writeGrantPolicy";
import { BackToConfigs } from "@/app/components/BackToConfigs";
import { ChangePasswordForm } from "@/app/components/ChangePasswordForm";
import { DeleteAccountForm } from "@/app/components/DeleteAccountForm";
import { McpConnectionCard, type McpGrantDto } from "@/app/components/McpConnectionCard";
import { ProviderKeyRow } from "@/app/components/ProviderKeyRow";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const { user, keys, mcpEnabled, writeGrants } = await withPageUser(async (user) => ({
    user,
    keys: await listProviderKeys(user.id),
    mcpEnabled: await readMcpEnabled(user.id),
    writeGrants: await listWriteGrants(user.id),
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
          Vault — a stolen copy of the database reveals nothing on its own. Because of that, we
          cannot show a key back to you after it is saved: only its last four characters. A key you
          have lost can be replaced, never recovered.
        </p>

        {/* The limit of the guarantee, stated where the key is typed rather than
            in a policy page nobody opens. Encryption at rest is the only property
            a server-side BYOK design can actually offer: the plaintext key must
            exist in memory to be sent to the provider, so it is reachable by
            anyone who can deploy code here. Saying so is what turns "trust us"
            into a decision the user is equipped to make. */}
        <p className="mt-2 max-w-prose text-xs text-zinc-500">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">
            What that does not cover.
          </span>{" "}
          To call a provider on your behalf, this server has to decrypt your key in memory and send
          it onward. Encryption at rest protects your key from a database breach; it cannot protect
          it from whoever operates the server. That is true of every product that stores an API key
          for you — it is worth stating rather than leaving you to assume otherwise.
        </p>

        {/* Detection where prevention is impossible. The link belongs directly
            under the limit it answers, and the framing has to stay honest: the
            ledger is written by this same server, so it is one half of a
            comparison against the provider's records, never a guarantee on its
            own. Anything warmer than that would be reassurance we cannot back. */}
        <p className="mt-2 max-w-prose text-xs text-zinc-500">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">
            What we can give you instead.
          </span>{" "}
          A record of every call this server made with your key —{" "}
          <Link href="/usage" className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200">
            API key usage
          </Link>
          . It cannot vouch for us, since we are the ones writing it. It is worth having because
          your provider keeps its own count: if the two disagree, the difference is spending you
          did not authorize.
        </p>

        <p className="mt-2 max-w-prose text-xs text-zinc-500">
          <span className="font-medium text-zinc-600 dark:text-zinc-400">
            So use a key you can afford to lose.
          </span>{" "}
          Create a key for this app alone rather than reusing an existing one, give it a spend limit
          where the provider offers one, and check the API key usage table frequently to see if it
          aligns with the provider&rsquo;s own records.
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
        // Names come from the OAuth grant list, so a write grant whose client has
        // since been disconnected shows its raw id rather than borrowing a name
        // from nowhere — that pairing is exactly the state worth noticing.
        writeGrants={writeGrants.map((grant) => ({
          clientId: grant.clientId,
          clientName:
            grants.find((row) => row.clientId === grant.clientId)?.clientName ?? grant.clientId,
          capabilities: grant.capabilities,
          expiresAt: grant.expiresAt.toISOString(),
          live: isLiveNow(grant),
        }))}
      />

      <section className="mt-12">
        <h2 className="text-sm font-medium">Password</h2>
        <p className="mt-1 max-w-prose text-xs text-zinc-500">
          Changing it signs out every other device. This one stays signed in. If you can&rsquo;t
          remember your current password,{" "}
          <Link
            href="/auth/forgot-password"
            className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
          >
            reset it by email
          </Link>{" "}
          instead.
        </p>
        <ChangePasswordForm />
      </section>

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

// Outside the component for react-hooks/purity: Date.now() during render is a
// value that changes between renders, which is precisely what the rule guards.
const isLiveNow = (grant: WriteGrant) => grantIsLive(grant, Date.now());

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
