// UI: "This will take a while — run it in the background?" (Client Component).
//
// Shown INSTEAD of starting a long bulk action, when the estimate crosses the
// threshold (POST /api/jobs/estimate decides both, so this component holds no
// policy). Three ways out, and all three are honest:
//
//   Run in the background — POST /api/jobs, close the tab, get an email.
//   Run here             — the existing NDJSON stream, unchanged.
//   Cancel               — nothing starts.
//
// The email promise is CONDITIONAL ON BEING ABLE TO KEEP IT: with no Resend key
// configured the copy says the job will be waiting in the panel instead of
// promising mail that has nowhere to come from.
"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/http/client";

export type Estimate = {
  kind: string;
  unit: string;
  units: number;
  seconds: number;
  source: "measured" | "seed";
  samples: number;
  thresholdSeconds: number;
  offerBackground: boolean;
  backgroundable: boolean;
  emailConfigured: boolean;
  email: string | null;
};

// "about 22 minutes" / "about an hour and a half". Deliberately coarse: the input
// is an average times a count, and a to-the-minute figure would imply a precision
// the estimate does not have.
export function humanDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  const h = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? h : `${h} ${rest} min`;
}

export function BackgroundOfferDialog({
  estimate,
  scope,
  onRunHere,
  onLaunched,
  onClose,
}: {
  estimate: Estimate;
  // The launch payload, passed through to POST /api/jobs untouched — this dialog
  // is deliberately kind-agnostic.
  scope: Record<string, unknown>;
  onRunHere: () => void;
  onLaunched: (message: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: estimate.kind, scope }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `Could not start the job (${res.status}).`);
        setBusy(false);
        return;
      }
      onLaunched(
        estimate.emailConfigured && estimate.email
          ? `Running in the background. You can close this tab — we'll email ${estimate.email} when it's done.`
          : `Running in the background. You can close this tab; the result will be waiting in the jobs panel.`,
      );
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-5 text-sm shadow-lg dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          This looks like about {humanDuration(estimate.seconds)}
        </h2>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          {estimate.units.toLocaleString()} {estimate.unit}
          {estimate.units === 1 ? "" : "s"} to process.{" "}
          {estimate.source === "seed"
            ? "That's a first guess — this config hasn't run one before."
            : `Based on your last ${estimate.samples} run${estimate.samples === 1 ? "" : "s"}.`}
        </p>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          {estimate.emailConfigured && estimate.email ? (
            <>
              Run it in the background and you can close the tab — we&apos;ll email{" "}
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                {estimate.email}
              </span>{" "}
              when it finishes.
            </>
          ) : (
            <>
              Run it in the background and you can close the tab — the result will be
              waiting in the jobs panel. (Email isn&apos;t configured on this
              deployment.)
            </>
          )}
        </p>

        {error && <p className="mt-3 text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onRunHere();
            }}
            disabled={busy}
            title="Stream it here — you'll need to leave this tab open"
            className="cursor-pointer rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Run here
          </button>
          <button
            type="button"
            onClick={launch}
            disabled={busy}
            className="cursor-pointer rounded bg-black px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {busy ? "Starting…" : "Run in the background"}
          </button>
        </div>
      </div>
    </div>
  );
}
