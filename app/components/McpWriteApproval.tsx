// UI: the Approve / Revoke controls on /account/mcp-write.
//
// A checkbox per capability rather than one "Allow" button, because the grant is
// stored as a set (0060) and the user has to be able to give less than was asked
// for. The agent's request only PRE-TICKS boxes; nothing here submits a
// capability the person did not leave ticked.
//
// Two separate forms, matching the consent screen's reasoning: approve and revoke
// are different decisions, and a mis-set hidden field should never be able to
// turn one into the other.
"use client";

import { useActionState } from "react";

import { approveMcpWrite, revokeMcpWrite, type McpWriteFormState } from "@/app/account/actions";

const BUTTON =
  "cursor-pointer rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

const LINK_BUTTON =
  "cursor-pointer text-xs text-red-600 underline decoration-dotted underline-offset-2 disabled:opacity-50 dark:text-red-400";

export type CapabilityOption = {
  id: string;
  label: string;
  proposed: boolean;
};

export function McpWriteApproval({
  clientId,
  clientName,
  exp,
  expiresAt,
  capabilities,
  existing,
}: {
  clientId: string;
  clientName: string;
  // The token expiry the agent passed through, in seconds. Null when it sent
  // none or sent something unreadable — the server falls back to the one-hour
  // ceiling either way, so this only affects what is displayed.
  exp: number | null;
  expiresAt: string;
  capabilities: CapabilityOption[];
  existing: { capabilities: string[]; expiresAt: string; live: boolean } | null;
}) {
  const [approveState, approveAction, approving] = useActionState(
    approveMcpWrite,
    {} as McpWriteFormState,
  );
  const [revokeState, revokeAction, revoking] = useActionState(
    revokeMcpWrite,
    {} as McpWriteFormState,
  );

  return (
    <>
      {existing ? (
        <div className="mt-6 rounded border border-zinc-200 p-4 text-xs dark:border-zinc-800">
          {/* A LAPSED grant is shown, not hidden. "It expired at 15:02" is the
              answer to "why did my agent's write just fail", and an empty panel
              would leave the user guessing. */}
          <p className="text-zinc-600 dark:text-zinc-400">
            {existing.live
              ? `Currently allowed until ${formatTime(existing.expiresAt)}.`
              : `A previous approval lapsed at ${formatTime(existing.expiresAt)}.`}
          </p>
          <p className="mt-1 text-zinc-500">{existing.capabilities.join(", ") || "nothing"}</p>
        </div>
      ) : null}

      <form action={approveAction} className="mt-6">
        <input type="hidden" name="clientId" value={clientId} />
        {exp === null ? null : <input type="hidden" name="exp" value={exp} />}

        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Allow {clientName} to
        </h2>
        <div className="mt-2 space-y-2">
          {capabilities.map((capability) => (
            <label key={capability.id} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="capability"
                value={capability.id}
                defaultChecked={capability.proposed}
                className="mt-0.5 size-4 cursor-pointer accent-zinc-900 dark:accent-zinc-100"
              />
              <span>{capability.label}</span>
            </label>
          ))}
        </div>

        <p className="mt-3 text-xs text-zinc-500">Expires {formatTime(expiresAt)}.</p>

        <button type="submit" disabled={approving} className={`${BUTTON} mt-4`}>
          {approving ? "Approving…" : "Approve"}
        </button>
      </form>

      {approveState.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {approveState.error}
        </p>
      ) : null}
      {approveState.granted ? (
        <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Approved. You can go back to your agent.
        </p>
      ) : null}

      {existing ? (
        <form action={revokeAction} className="mt-6">
          <input type="hidden" name="clientId" value={clientId} />
          <button type="submit" disabled={revoking} className={LINK_BUTTON}>
            {revoking ? "Revoking…" : "Revoke write access"}
          </button>
        </form>
      ) : null}

      {revokeState.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {revokeState.error}
        </p>
      ) : null}
      {revokeState.revoked ? (
        <p role="status" className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Revoked. The next write will be refused.
        </p>
      ) : null}
    </>
  );
}

// Time only: every grant on this page expires within the hour, so a date would
// be noise. An unparseable value degrades to "soon" rather than "Invalid Date".
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
