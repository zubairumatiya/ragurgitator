// The account page: identity, provider keys, MCP access, password, deletion.
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
//
// LAYOUT NOTE. This page used to be a bare max-w-2xl column with an h1 the size of
// a section heading, while every other standalone page (/usage, /cache, /corpora,
// /appraise) uses the zinc-50 shell, a text-2xl heading and bordered cards. It is in
// that family now. The provider-key section in particular opened with four
// paragraphs — roughly 330 words before the first input, which put every key field
// below the fold — so the argument for BYOK now lives in the heading's "?" and only
// the sentence you would keep if you could keep one stays on screen.
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
import { SectionCard, SectionIntro } from "@/app/components/SectionCard";

export const metadata = { title: "Account" };

// The BYOK argument, in full, behind the "?" on Provider API keys. Three things in
// the order that makes them honest: what the encryption buys, what it cannot buy,
// and what to do about the gap. The middle one is the reason this text exists —
// every product that stores an API key has to decrypt it to spend it, and saying so
// is what turns "trust us" into a decision the user is equipped to make.
//
// The /usage link is NOT in here. Tooltip's bubble is pointer-events-none, so a
// link inside it could never be clicked; it sits on the heading row instead, which
// is where an action belonged anyway.
const KEYS_ABOUT =
  "Your keys are encrypted before they are stored, under a key that never " +
  "leaves Azure Key Vault — a stolen copy of the database reveals nothing on " +
  "its own. Because of that, we cannot show a key back to you after it is " +
  "saved: only its last four characters. A key you have lost can be replaced, " +
  "never recovered.\n\n" +
  "WHAT THAT DOES NOT COVER. To call a provider on your behalf, this server has " +
  "to decrypt your key in memory and send it onward. Encryption at rest protects " +
  "your key from a database breach; it cannot protect it from whoever operates " +
  "the server. That is true of every product that stores an API key for you — it " +
  "is worth stating rather than leaving you to assume otherwise.\n\n" +
  "WHAT WE CAN GIVE YOU INSTEAD. A record of every call this server made with " +
  "your key, on the API key usage page. It cannot vouch for us, since we are the " +
  "ones writing it. It is worth having because your provider keeps its own " +
  "count: if the two disagree, the difference is spending you did not " +
  "authorize.\n\n" +
  "SO USE A KEY YOU CAN AFFORD TO LOSE. Create a key for this app alone rather " +
  "than reusing an existing one, give it a spend limit where the provider offers " +
  "one, and check the usage table often enough that a divergence would surprise " +
  "you rather than accumulate.";

export default async function AccountPage() {
  const { user, keys, mcpEnabled, writeGrants } = await withPageUser(async (user) => ({
    user,
    keys: await listProviderKeys(user.id),
    mcpEnabled: await readMcpEnabled(user.id),
    writeGrants: await listWriteGrants(user.id),
  }));

  const byProvider = new Map<string, ProviderKeyDto>(keys.map((k) => [k.provider, k]));
  const keysSet = PROVIDER_IDS.filter((id) => byProvider.has(id)).length;

  // Read OUTSIDE the scope: this is a Supabase Auth call, not a store call, so
  // it has no business holding the RLS transaction open across a network round
  // trip. Skipped entirely when the feature is off — there is nothing to show.
  const { grants, grantsError } = mcpEnabled
    ? await readMcpGrants()
    : { grants: [], grantsError: null };

  const liveWriteGrants = writeGrants.filter((grant) => isLiveNow(grant)).length;

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-6 px-8 py-12">
        {/* The way back. /account has no tab bar of its own, and "/" would dump
            you on your first open config rather than the one you left. */}
        <BackToConfigs />

        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Account
          </h1>
          {/* No sign-out button here on purpose: the sidebar carries one on every
              page, and a second copy would only raise the question of whether the
              two do the same thing. */}
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{user.email}</p>
        </header>

        {/* The answer to "why did I open this page", above the fold and costing
            nothing — every figure here is already loaded for the sections below. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="Provider keys"
            value={`${keysSet} of ${PROVIDER_IDS.length}`}
            detail={keysSet === 0 ? "none set yet" : "set"}
          />
          <StatTile
            label="MCP access"
            value={mcpEnabled ? "On" : "Off"}
            detail={
              !mcpEnabled
                ? "no agents can connect"
                : grantsError
                  ? "connected agents unknown"
                  : `${grants.length} agent${grants.length === 1 ? "" : "s"} connected` +
                    (liveWriteGrants > 0 ? ` · ${liveWriteGrants} can write` : "")
            }
          />
          <StatTile
            label="API key usage"
            value="Ledger"
            detail="every call made with your keys"
            href="/usage"
          />
        </div>

        <SectionCard
          title="Provider API keys"
          info={KEYS_ABOUT}
          action={
            <Link
              href="/usage"
              className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              API key usage →
            </Link>
          }
        >
          {/* One sentence stays visible. A caveat only a hover reveals is a caveat
              quietly deleted, so the part that changes what the user DOES — you
              cannot get this key back — is never behind the "?". */}
          <SectionIntro>
            Encrypted at rest under a key held in Azure Key Vault, and never shown back to you
            afterwards — only the last four characters. Read the{" "}
            <span className="font-medium text-zinc-600 dark:text-zinc-400">?</span> before you paste
            a key you would mind losing.
          </SectionIntro>

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
        </SectionCard>

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

        <SectionCard title="Password">
          <SectionIntro>
            Changing it signs out every other device. This one stays signed in. If you can&rsquo;t
            remember your current password,{" "}
            <Link
              href="/auth/forgot-password"
              className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              reset it by email
            </Link>{" "}
            instead.
          </SectionIntro>
          <ChangePasswordForm />
        </SectionCard>

        <SectionCard title="Delete account" tone="danger">
          <SectionIntro>
            Permanently deletes your account and every provider key on it. This cannot be undone,
            and nothing here is recoverable afterwards — the stored keys become unopenable the
            moment the rows are gone.
          </SectionIntro>
          <DeleteAccountForm />
        </SectionCard>
      </main>
    </div>
  );
}

// One figure from the page below, readable without scrolling. A tile with `href`
// renders as a link — the usage ledger is the one thing here whose value is a
// destination rather than a state.
function StatTile({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: string;
  detail: string;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-zinc-500">{detail}</p>
    </>
  );

  const shell = "rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950";

  return href ? (
    <Link href={href} className={`${shell} block transition-colors hover:border-zinc-400 dark:hover:border-zinc-600`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
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
