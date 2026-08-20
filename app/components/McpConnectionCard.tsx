// UI: connect an AI agent to this account over MCP.
//
// Three things, in the order a user needs them: the switch that turns the endpoint
// on, the snippet they paste into their agent, and the list of what is currently
// connected so they can cut any of it off.
//
// THE SNIPPET CONTAINS NO TOKEN, and that is the feature rather than an omission.
// The agent discovers the authorization server from the endpoint itself, a browser
// opens to our consent page, and the credential is minted after a human clicks
// Approve — so there is never a secret sitting in a config file to leak. If you
// find yourself adding a "copy your API key" field to this card, the design has
// regressed.
//
// FIRST CLIPBOARD USE IN THE CODEBASE. navigator.clipboard is unavailable on
// insecure origins and can be permission-denied, so the write is wrapped and a
// failure leaves the snippet visible and selectable — the copy button is a
// convenience over text already on screen, never the only way to get it.
//
// THE SNIPPET IS COLLAPSED. It is a one-time setup step, and left open it took
// more vertical space than the connected-agent list it sat above — so the thing
// you check occasionally outranked the thing you check repeatedly. <details>
// rather than useState so it costs no hydration and stays keyboard-operable.
"use client";

import { useActionState, useEffect, useState } from "react";

import {
  revokeMcpGrant,
  revokeMcpWrite,
  setMcpEnabled,
  type McpFormState,
  type McpWriteFormState,
} from "@/app/account/actions";
import { BUTTON } from "@/app/components/formStyles";
import { SectionCard, SectionIntro, StatusPill, SubHeading } from "@/app/components/SectionCard";

const LINK_BUTTON =
  "cursor-pointer text-xs text-red-600 underline decoration-dotted underline-offset-2 disabled:opacity-50 dark:text-red-400";

// The full explanation, behind the heading's "?". What stays on screen is the one
// sentence that changes what the user does; this is the part they read once.
const ABOUT =
  "An AI agent — Claude Code, Claude Desktop, Cursor — can read your configs " +
  "directly over MCP: settings, documents, overrides, costs and evaluation " +
  "scores.\n\n" +
  "NO KEY IS EVER PASTED ANYWHERE. Connecting signs you into this app in a " +
  "browser and asks for your approval; the agent's credential is minted after " +
  "you click Approve, so there is never a secret sitting in a config file to " +
  "leak.\n\n" +
  "Agents get READ access to configuration only — never your documents. Write " +
  "access is separate, granted one approval at a time, and lapses within the " +
  "hour; anything currently holding it is listed under Write access below.";

export type McpGrantDto = {
  clientId: string;
  clientName: string;
  scopes: string[];
  grantedAt: string;
};

// A write grant as the card shows it (0060). `live` is computed on the server so
// the two never disagree about the clock, and a LAPSED grant is still listed —
// "it expired at 15:02" is the answer to "why did my agent's write fail", which
// an empty list would not give.
export type McpWriteGrantDto = {
  clientId: string;
  clientName: string;
  capabilities: string[];
  expiresAt: string;
  live: boolean;
};

export function McpConnectionCard({
  enabled,
  serverUrl,
  grants,
  grantsError,
  writeGrants,
}: {
  enabled: boolean;
  serverUrl: string;
  grants: McpGrantDto[];
  writeGrants: McpWriteGrantDto[];
  // Non-null when the grant list could not be read — almost always "the OAuth
  // server isn't enabled on this project yet". Shown rather than swallowed,
  // because an empty list and an unavailable list mean very different things.
  grantsError: string | null;
}) {
  const [toggleState, toggleAction, toggling] = useActionState(
    setMcpEnabled,
    {} as McpFormState,
  );

  const snippet = JSON.stringify(
    { mcpServers: { rag: { type: "http", url: serverUrl } } },
    null,
    2,
  );

  return (
    <SectionCard
      title="MCP access"
      info={ABOUT}
      action={<StatusPill tone={enabled ? "positive" : "neutral"}>{enabled ? "On" : "Off"}</StatusPill>}
    >
      <SectionIntro>
        Let an AI agent — Claude Code, Claude Desktop, Cursor — read your configs directly. Agents
        can read configuration only: never your documents, and nothing they can change.
      </SectionIntro>

      {/* Auto-submits on toggle: a checkbox paired with its own Save button asks
          the user to confirm a switch they have already flipped, and leaves the
          control lying about the server's state until they do. The button is gone
          rather than kept as a no-JS fallback — the clipboard copy and the
          collapsed snippet beside it never worked without JS either, so pretending
          this one control did would be the misleading half-measure. */}
      <form action={toggleAction} className="mt-4 flex items-center gap-2">
        <input
          type="checkbox"
          id="mcpEnabled"
          name="mcpEnabled"
          defaultChecked={enabled}
          // NOT disabled while saving. A disabled input is left out of FormData,
          // so the pending state would submit the toggle without the field it
          // exists to carry.
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="size-4 cursor-pointer accent-zinc-900 dark:accent-zinc-100"
        />
        <label htmlFor="mcpEnabled" className="cursor-pointer text-sm">
          Allow agents to connect
        </label>
        {toggling ? <span className="text-xs text-zinc-500">Saving…</span> : null}
      </form>

      {toggleState.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {toggleState.error}
        </p>
      ) : null}

      {enabled ? (
        <>
          <Snippet snippet={snippet} />
          <ConnectedClients grants={grants} grantsError={grantsError} />
          <WriteGrants grants={writeGrants} />
        </>
      ) : (
        <p className="mt-4 text-xs text-zinc-500">
          Turn this on to get the configuration snippet for your agent.
        </p>
      )}
    </SectionCard>
  );
}

function Snippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  // Clear the confirmation rather than leaving "Copied" on screen forever, which
  // would make a later failed copy look like it worked.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      // No clipboard (insecure origin, denied permission). The text is on
      // screen and selectable, so there is nothing to recover from — saying
      // "copied" when it wasn't would be the actual failure.
      setCopied(false);
    }
  }

  return (
    <details className="group mt-6 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      {/* list-none alone leaves the disclosure triangle in Safari, which still
          draws it via ::-webkit-details-marker — the "show config" hint below is
          the affordance, and two of them side by side is one too many. */}
      <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 [&::-webkit-details-marker]:hidden dark:hover:text-zinc-300">
        Add this to your agent
        <span aria-hidden className="ml-1 font-sans normal-case group-open:hidden">
          — show config
        </span>
      </summary>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          In Claude Code this goes in a <code>.mcp.json</code> file at the root of your project;
          restart Claude Code, then run <code>/mcp</code> to authenticate.
        </p>
        <button type="button" onClick={copy} className={`${BUTTON} ml-3 shrink-0`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mt-2 overflow-x-auto rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
        <code>{snippet}</code>
      </pre>
    </details>
  );
}

function ConnectedClients({
  grants,
  grantsError,
}: {
  grants: McpGrantDto[];
  grantsError: string | null;
}) {
  return (
    <div className="mt-8">
      <SubHeading>Connected agents</SubHeading>

      {grantsError ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {grantsError}
        </p>
      ) : grants.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">
          Nothing connected yet. Agents appear here after you approve them.
        </p>
      ) : (
        <div className="mt-2">
          {grants.map((grant) => (
            <GrantRow key={grant.clientId} grant={grant} />
          ))}
        </div>
      )}
    </div>
  );
}

// WRITE ACCESS, listed separately from the connection above it, because the two
// are different kinds of permission with different lifetimes: connecting lasts
// until you disconnect it, writing lapses within the hour. Folding them into one
// row would imply the second is as durable as the first.
//
// Revoking here bites immediately — the write tools read the grant row on every
// call — which is the opposite of Disconnect above, whose already-issued access
// token stays signature-valid until it expires.
function WriteGrants({ grants }: { grants: McpWriteGrantDto[] }) {
  if (grants.length === 0) return null;

  return (
    <div className="mt-8">
      <SubHeading>Write access</SubHeading>
      <div className="mt-2">
        {grants.map((grant) => (
          <WriteGrantRow key={grant.clientId} grant={grant} />
        ))}
      </div>
    </div>
  );
}

function WriteGrantRow({ grant }: { grant: McpWriteGrantDto }) {
  const [state, action, pending] = useActionState(revokeMcpWrite, {} as McpWriteFormState);

  return (
    <div className="border-t border-zinc-200 py-3 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-sm">{grant.clientName}</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {grant.live
              ? `Can write until ${formatTime(grant.expiresAt)} · ${grant.capabilities.join(", ")}`
              : `Lapsed at ${formatTime(grant.expiresAt)}`}
          </p>
        </div>
        {grant.live ? (
          <form action={action}>
            <input type="hidden" name="clientId" value={grant.clientId} />
            <button type="submit" disabled={pending} className={LINK_BUTTON}>
              {pending ? "Revoking…" : "Revoke"}
            </button>
          </form>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function GrantRow({ grant }: { grant: McpGrantDto }) {
  const [state, action, pending] = useActionState(
    revokeMcpGrant,
    {} as McpFormState,
  );

  return (
    <div className="border-t border-zinc-200 py-3 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-sm">{grant.clientName}</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Connected {formatDate(grant.grantedAt)}
            {grant.scopes.length > 0 ? ` · ${grant.scopes.join(", ")}` : ""}
          </p>
        </div>
        <form action={action}>
          <input type="hidden" name="clientId" value={grant.clientId} />
          <button type="submit" disabled={pending} className={LINK_BUTTON}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </button>
        </form>
      </div>
      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

// Time only for write grants: every one of them expires within the hour, so a
// date would be noise.
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
