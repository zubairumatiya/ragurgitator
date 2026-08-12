// ---------------------------------------------------------------------------
// UI: connect an AI agent to this account over MCP.
//
// Three things, in the order a user needs them: the switch that turns the
// endpoint on, the snippet they paste into their agent, and the list of what is
// currently connected so they can cut any of it off.
//
// THE SNIPPET CONTAINS NO TOKEN, and that is the feature rather than an
// omission. The agent discovers the authorization server from the endpoint
// itself, a browser opens to our consent page, and the credential is minted
// after a human clicks Approve — so there is never a secret sitting in a config
// file to leak, and nothing here is sensitive to display. If you find yourself
// adding a "copy your API key" field to this card, the design has regressed.
//
// FIRST CLIPBOARD USE IN THE CODEBASE. navigator.clipboard is unavailable on
// insecure origins and can be permission-denied, so the write is wrapped and a
// failure leaves the snippet visible and selectable — the copy button is a
// convenience over text that is already on screen, never the only way to get it.
// BackToConfigs.tsx is the precedent for a browser API behind graceful
// degradation.
// ---------------------------------------------------------------------------
"use client";

import { useActionState, useEffect, useState } from "react";

import { revokeMcpGrant, setMcpEnabled, type McpFormState } from "@/app/account/actions";

const BUTTON =
  "cursor-pointer rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

const LINK_BUTTON =
  "cursor-pointer text-xs text-red-600 underline decoration-dotted underline-offset-2 disabled:opacity-50 dark:text-red-400";

export type McpGrantDto = {
  clientId: string;
  clientName: string;
  scopes: string[];
  grantedAt: string;
};

export function McpConnectionCard({
  enabled,
  serverUrl,
  grants,
  grantsError,
}: {
  enabled: boolean;
  serverUrl: string;
  grants: McpGrantDto[];
  // Non-null when the grant list could not be read — almost always "the OAuth
  // server isn't enabled on this project yet". Shown rather than swallowed,
  // because an empty list and an unavailable list mean very different things.
  grantsError: string | null;
}) {
  const [toggleState, toggleAction, toggling] = useActionState(setMcpEnabled, {} as McpFormState);

  const snippet = JSON.stringify(
    { mcpServers: { rag: { type: "http", url: serverUrl } } },
    null,
    2,
  );

  return (
    <section className="mt-12">
      <h2 className="text-sm font-medium">MCP access</h2>
      <p className="mt-1 max-w-prose text-xs text-zinc-500">
        Let an AI agent — Claude Code, Claude Desktop, Cursor — read your configs directly:
        settings, documents, overrides, costs and evaluation scores. Connecting signs you into
        this app and asks for your approval, so no key is ever pasted anywhere. Agents can read
        configuration only: never your documents, and nothing they can change.
      </p>

      <form action={toggleAction} className="mt-4 flex items-center gap-2">
        <input
          type="checkbox"
          id="mcpEnabled"
          name="mcpEnabled"
          defaultChecked={enabled}
          className="size-4 cursor-pointer accent-zinc-900 dark:accent-zinc-100"
        />
        <label htmlFor="mcpEnabled" className="cursor-pointer text-sm">
          Allow agents to connect
        </label>
        <button type="submit" disabled={toggling} className={`${BUTTON} ml-2`}>
          {toggling ? "Saving…" : "Save"}
        </button>
      </form>

      {toggleState.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {toggleState.error}
        </p>
      ) : null}
      {toggleState.saved ? (
        <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Saved.
        </p>
      ) : null}

      {enabled ? (
        <>
          <Snippet snippet={snippet} />
          <ConnectedClients grants={grants} grantsError={grantsError} />
        </>
      ) : (
        <p className="mt-4 text-xs text-zinc-500">
          Turn this on to get the configuration snippet for your agent.
        </p>
      )}
    </section>
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
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Add this to your agent
        </h3>
        <button type="button" onClick={copy} className={BUTTON}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mt-2 overflow-x-auto rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
        <code>{snippet}</code>
      </pre>
      <p className="mt-2 text-xs text-zinc-500">
        In Claude Code this goes in <code>.mcp.json</code>; then run <code>/mcp</code> to
        authenticate. Your browser will open here to confirm.
      </p>
    </div>
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
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Connected agents
      </h3>

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

function GrantRow({ grant }: { grant: McpGrantDto }) {
  const [state, action, pending] = useActionState(revokeMcpGrant, {} as McpFormState);

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

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
