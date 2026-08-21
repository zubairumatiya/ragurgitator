// THE OAUTH CONSENT SCREEN — the reason this design uses OAuth instead of a
// pasted API key.
//
// Supabase runs the authorization server, but it does not decide who says yes. It
// redirects the user's browser HERE, and this page is where a human approves.
// The credential is minted only after that, and the grant is revocable from
// /account. An unauthenticated visit REDIRECTS TO LOGIN rather than erroring:
// arriving without a session is the normal first-time path. Signing in IS the
// identity proof — the agent that sent you here cannot approve on your behalf.
//
// THIS PAGE IS THE MITIGATION FOR DYNAMIC CLIENT REGISTRATION, so it carries more
// weight than a consent screen normally would. Read this before simplifying it.
//
// DCR means any party can register an OAuth client, unauthenticated, under any
// name they like — including "Claude Code". Registration alone grants nothing, so
// the attack it enables is not theft but CONSENT PHISHING: lure the user to an
// authorize URL, show a legitimate-looking screen, and collect the grant.
//
// What the design relies on to blunt that:
//
//   - The client NAME is untrusted input, presented as a claim ("calling itself
//     X"), never as an identity. Emphasising it would be doing the attacker's
//     typography for them.
//   - The REDIRECT URI is shown, because it is the one field an attacker cannot
//     forge into something reassuring: OAuth 2.1 mandates exact matching, so a
//     fake "Claude Code" pointing at evil.example is legible here.
//   - client.logo_uri and client.uri are deliberately NOT rendered. A remote image
//     controlled by the registrant is a tracking pixel and a credibility prop at
//     once, and a clickable link is a phishing hop.
//   - PKCE means a spoofed client cannot intercept a legitimate client's code.
//
// TWO POSSIBLE ANSWERS from getAuthorizationDetails, and both have to be handled.
// If the user has already consented to this client and these scopes, Supabase
// skips straight to a redirect and returns { redirect_url } instead of
// authorization details — rendering a consent form then would ask a question
// already answered, with no authorization_id to submit. Narrow on
// 'authorization_id' in data.
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth/dal";
import { serverSupabase } from "@/lib/auth/supabase";
import { Wordmark } from "@/app/components/Logo";

export const metadata = { title: "Authorize access" };

// Never cache: every render is about one specific pending authorization.
export const dynamic = "force-dynamic";

const BUTTON =
  "cursor-pointer rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

const SECONDARY =
  "cursor-pointer rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

// The scopes Supabase can issue, verbatim from its own scopes_supported. Shown in
// plain language because "phone" or "offline_access" tells a user nothing about
// what an agent will actually do with it.
//
// offline_access is the one worth spelling out honestly: it is a REFRESH token, so
// the grant outlives the browser session that created it. That is the normal thing
// for an MCP client to want and also the thing a user should understand they are
// agreeing to, which is why it is described by its consequence rather than its name.
//
// An unrecognised scope falls through to its raw name below — better a bare string
// the user can search for than silently hiding something that was granted.
const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your basic profile",
  phone: "See your phone number",
  offline_access: "Stay connected until you disconnect it, without asking again",
};

export default async function ConsentPage({
  searchParams,
}: {
  // Async in Next 16 — searchParams is a Promise.
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: authorizationId } = await searchParams;

  const user = await getSessionUser();
  if (!user) {
    // Come back here afterwards. The param is `next` (not `redirect`), and
    // safeNext() in app/auth/actions.ts accepts it because it is a single-slash
    // relative path.
    const back = `/oauth/consent${authorizationId ? `?authorization_id=${encodeURIComponent(authorizationId)}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  if (!authorizationId) {
    return (
      <Shell title="Nothing to authorize">
        <p className="mt-2 text-sm text-zinc-500">
          This page is opened by an application asking for access. There is no pending request
          here, so there is nothing to approve.
        </p>
      </Shell>
    );
  }

  const supabase = await serverSupabase();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);

  if (error || !data) {
    return (
      <Shell title="That request has expired">
        <p className="mt-2 text-sm text-zinc-500">
          This authorization request is no longer valid. Start the connection again from your
          application and a fresh one will be created.
        </p>
      </Shell>
    );
  }

  // Already consented — Supabase has minted the code, so send them straight on.
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  const scopes = data.scope.split(" ").filter(Boolean);
  // UNTRUSTED. With dynamic client registration on, any party can register a
  // client under any name — including "Claude Code" — so this string is a claim,
  // not an identity. It is rendered plainly rather than emphasised for exactly
  // that reason; see the redirect_uri note below for the field that can't be
  // faked.
  const clientName = data.client.name || "An application";
  const destination = redirectHost(data.redirect_uri);

  return (
    <Shell title="Authorize access">
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        An application calling itself <span className="font-medium">{clientName}</span> is asking to
        connect to your RAG account as <span className="font-medium">{user.email}</span>.
      </p>

      <div className="mt-6 rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          It will be able to
        </h2>
        <ul className="mt-2 space-y-1 text-sm">
          {scopes.map((scope) => (
            <li key={scope}>{SCOPE_LABELS[scope] ?? scope}</li>
          ))}
          {/* Stated explicitly because it is the part the OIDC scope list does
              NOT cover, and it is the part that actually matters here. Supabase
              issues no custom scopes, so the tool surface is not something the
              user can narrow at this screen — the honest thing is to say what it
              is rather than let the scope list imply a limit it isn't enforcing. */}
          <li>Read your config settings, costs and evaluation scores</li>
        </ul>
        <p className="mt-3 text-xs text-zinc-500">
          It cannot read your documents or any chunk text, and it cannot change anything.
        </p>
      </div>

      {/* THE ANTI-PHISHING CONTROL, and the reason this block exists at all.
          The client NAME is self-declared and worthless as identity. The
          redirect_uri is not: OAuth 2.1 requires exact matching, so the
          credential can only ever be delivered to the URI the client registered.
          Showing it means a spoofed "Claude Code" pointing at someone else's
          server is visible here rather than indistinguishable from the real one.
          An agent on this machine sends you back to loopback; anything else is
          worth a second look, which is why the two cases read differently. */}
      <div className="mt-4 rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Access will be sent to
        </h2>
        <p className="mt-2 break-all font-mono text-sm">{data.redirect_uri}</p>
        <p className="mt-2 text-xs text-zinc-500">
          {destination.isLoopback
            ? "This is an application running on your own machine."
            : `This is not your machine — it will send your access to ${destination.host}. Only continue if you recognise it.`}
        </p>
      </div>

      <p className="mt-4 text-xs text-zinc-500">
        Only approve this if you started the connection yourself, just now. The name above is
        chosen by whoever built the application and is not verified by us. You can disconnect it at
        any time from your account page.
      </p>

      <div className="mt-6 flex items-center gap-2">
        {/* Two forms rather than one with two submit values: the decision is the
            entire payload, and a mis-set hidden field should not be able to turn
            a Deny into an Approve. */}
        <form action="/api/oauth/decision" method="post">
          <input type="hidden" name="authorization_id" value={authorizationId} />
          <input type="hidden" name="decision" value="approve" />
          <button type="submit" className={BUTTON}>
            Approve
          </button>
        </form>
        <form action="/api/oauth/decision" method="post">
          <input type="hidden" name="authorization_id" value={authorizationId} />
          <input type="hidden" name="decision" value="deny" />
          <button type="submit" className={SECONDARY}>
            Deny
          </button>
        </form>
      </div>
    </Shell>
  );
}

// A legitimate local agent completes the flow on a loopback listener, so that is
// the reassuring case. An unparseable URI is treated as NOT loopback: the point
// of this is to make a suspicious destination visible, and a URI we can't read
// is not something to reassure anyone about.
function redirectHost(uri: string): { host: string; isLoopback: boolean } {
  try {
    const { hostname } = new URL(uri);
    return {
      host: hostname,
      isLoopback: hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]",
    };
  } catch {
    return { host: uri, isLoopback: false };
  }
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-6 py-16">
      {/* This page is reached from a third-party client, so it has to say whose
          account is about to be handed out before it says what is being asked. */}
      <Wordmark size={26} className="mb-7" />
      <h1 className="text-lg font-medium">{title}</h1>
      {children}
    </div>
  );
}
