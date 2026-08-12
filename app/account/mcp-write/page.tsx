// THE WRITE-GRANT APPROVAL SCREEN — where a human says yes to an agent writing.
//
// The read side of MCP needed no page like this: /oauth/consent approves the
// connection, and describe_config cannot change anything. Writing is a different
// question, asked at a different time, so it gets its own answer here.
//
// WHY THE ANSWER IS SHORT-LIVED. The grant lapses within the hour (0060), which
// makes this page something the user visits during a session rather than once
// ever. That is the point: "is a person at the keyboard right now, expecting this
// agent to write" is the actual question, and the only honest way to ask it is to
// make the yes expire.
//
// EVERY QUERY PARAMETER IS UNTRUSTED — the link is composed by the agent. See
// approveMcpWrite in ../actions.ts for the two properties that make that safe
// (the client must already be connected; a proposed expiry can only shorten).
// Here that shows up as presentation: the client name is looked up from the
// user's OWN Supabase grants by client_id, never taken from the URL, so a
// reassuring name cannot be supplied by whoever wrote the link.
import { redirect } from "next/navigation";

import { getSessionUser, withPageUser } from "@/lib/auth/dal";
import { serverSupabase } from "@/lib/auth/supabase";
import { describeGrant } from "@/lib/mcp/writeGrant";
import {
  CAPABILITY_LABELS,
  WRITE_CAPABILITIES,
  type WriteCapability,
  type WriteGrant,
  grantExpiry,
  grantIsLive,
  isWriteCapability,
} from "@/lib/mcp/writeGrantPolicy";
import { McpWriteApproval } from "@/app/components/McpWriteApproval";

export const metadata = { title: "Allow an agent to write" };

// Never cache: every render is about one client's grant as it stands right now,
// and the whole page is a countdown.
export const dynamic = "force-dynamic";

export default async function McpWritePage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ client_id?: string; exp?: string; capabilities?: string }>;
}) {
  const params = await searchParams;
  const clientId = params.client_id?.trim() ?? "";

  // Come back HERE after signing in, query string intact. withPageUser below
  // would also redirect, but to a bare /login that loses the link — and arriving
  // here without a session is the normal path, since the link is opened from a
  // terminal rather than from inside the app. `next` is the param safeNext()
  // accepts (app/auth/actions.ts); a single-slash relative path passes it.
  if (!(await getSessionUser())) {
    const back = `/account/mcp-write?${new URLSearchParams(
      Object.entries(params).filter(([, value]) => typeof value === "string") as [string, string][],
    )}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  // The agent's proposal, not the decision. Unknown names are dropped silently
  // rather than shown as an unchecked mystery box — a capability this build does
  // not implement cannot be granted, so displaying it would only invite the user
  // to tick something inert.
  const proposed = new Set<WriteCapability>(
    (params.capabilities ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(isWriteCapability),
  );

  if (!clientId) {
    return (
      <Shell title="Nothing to approve">
        <p className="mt-2 text-sm text-zinc-500">
          This page is opened from a link an agent gives you, naming itself. There is no client in
          this one, so there is nothing to decide.
        </p>
      </Shell>
    );
  }

  const { existing, email } = await withPageUser(async (user) => ({
    existing: await describeGrant(user.id, clientId),
    email: user.email,
  }));

  // Read OUTSIDE the scope — a Supabase Auth call has no business holding the
  // RLS transaction open across a network round trip (same reasoning as
  // /account's grant list).
  const client = await readClient(clientId);

  if (!client) {
    return (
      <Shell title="That agent is not connected">
        <p className="mt-2 text-sm text-zinc-500">
          No connected client matches <span className="font-mono break-all">{clientId}</span> on
          this account. Connect the agent from your account page first — writing is an extra step
          on top of a connection, never a way to create one.
        </p>
      </Shell>
    );
  }

  const expSeconds = Number(params.exp);
  const expiresAt = proposedExpiry(expSeconds);

  return (
    <Shell title="Allow an agent to write">
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">{client.name}</span> is asking to write to your RAG account
        as <span className="font-medium">{email}</span>. It is already connected and can read your
        configs; this grants it more.
      </p>

      <McpWriteApproval
        clientId={clientId}
        clientName={client.name}
        exp={Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds : null}
        expiresAt={expiresAt.toISOString()}
        capabilities={WRITE_CAPABILITIES.map((id) => ({
          id,
          label: CAPABILITY_LABELS[id],
          proposed: proposed.has(id),
        }))}
        existing={
          existing
            ? {
                capabilities: existing.capabilities,
                expiresAt: existing.expiresAt.toISOString(),
                live: isLiveNow(existing),
              }
            : null
        }
      />

      <p className="mt-6 text-xs text-zinc-500">
        Approving expires on its own — at most an hour, and never later than the agent&rsquo;s
        current access token. You can revoke it here at any time, and unlike disconnecting a
        client, revoking a write grant stops the very next write.
      </p>
    </Shell>
  );
}

// Both clock reads sit OUTSIDE the component. react-hooks/purity rightly refuses
// Date.now() during render — a value that changes between renders is exactly what
// it guards — and here the answer is a countdown that is meant to be re-read on
// every request, which `dynamic = "force-dynamic"` above already guarantees.
function proposedExpiry(expSeconds: number): Date {
  const exp = Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds : undefined;
  return grantExpiry(Date.now(), exp);
}

const isLiveNow = (grant: WriteGrant) => grantIsLive(grant, Date.now());

// The client's display name, looked up from the user's own grants. Never from the
// URL: the name is the one field an attacker would most like to choose.
async function readClient(clientId: string): Promise<{ name: string } | null> {
  try {
    const supabase = await serverSupabase();
    const { data, error } = await supabase.auth.oauth.listGrants();
    if (error || !data) return null;
    const grant = data.find((row) => row.client.id === clientId);
    if (!grant) return null;
    return { name: grant.client.name || "An unnamed agent" };
  } catch {
    return null;
  }
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-6 py-16">
      <h1 className="text-lg font-medium">{title}</h1>
      {children}
    </div>
  );
}
