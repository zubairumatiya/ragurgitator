// UI: "This will take a while" — run it in the background, or keep this tab open.
//
// Shown INSTEAD of starting a long bulk action, when the estimate crosses the
// threshold (POST /api/jobs/estimate decides both, so this component holds no
// policy). It has two faces, and which one appears is the server's `backgroundable`:
//
//   Backgroundable — Run in the background / Run here / Cancel.
//   Not            — a keep-this-tab-open warning: Run here / Cancel, plus the
//                    blocker's `fix` when the thing refusing is a SETTING the user
//                    can change from here (autotune's apply='choose' today).
//
// The warn-only face exists because the estimate is worth showing even when the
// background is unavailable: those runs are the ones that hold a tab hostage, and
// a user who knows it is 40 minutes can go and start it at a better time.
//
// The email promise is CONDITIONAL ON BEING ABLE TO KEEP IT: with no Resend key
// configured the copy says the job will be waiting in the panel instead of
// promising mail that has nowhere to come from.
"use client";

import { useState } from "react";

import { EVAL_CRITERIA_CHANGED } from "@/app/components/EvalSettings";
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
  // Why not, when backgroundable is false and the kind is wired at all. Mirrors
  // lib/jobs/registry.ts's BackgroundBlock.
  blocked?: {
    reason: string;
    fix?: { id: "autotune_auto_best"; label: string; note: string };
  } | null;
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

// The settings change behind a blocker's `fix`, by id. Kept here rather than sent
// down as a patch body: the server naming a change the client posts back to the
// server would be a request with no author.
const FIX_PATCH: Record<string, Record<string, unknown>> = {
  autotune_auto_best: { autotune: { apply: "auto_best" } },
};

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
  const blocked = estimate.blocked ?? null;
  const fix = blocked?.fix;

  function launchedMessage(): string {
    return estimate.emailConfigured && estimate.email
      ? `Running in the background. You can close this tab — we'll email ${estimate.email} when it's done.`
      : `Running in the background. You can close this tab; the result will be waiting in the jobs panel.`;
  }

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
      onLaunched(launchedMessage());
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  // Save the setting that is refusing the background, then launch. The PATCH has
  // to land BEFORE the POST and be checked: /api/jobs asks backgroundBlocker again
  // (the estimate is advisory, that route is the door), so launching on a failed
  // save would just collect a 409 — and worse, a save that half-worked would leave
  // the user's Apply mode changed for a run that never started.
  async function applyFixAndLaunch() {
    if (!fix) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/eval/criteria", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(FIX_PATCH[fix.id]),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not change the setting (${res.status}).`);
        setBusy(false);
        return;
      }
      // The settings panel and the dashboard banner both read this — without it
      // they would keep showing 'choose' until the next reload.
      window.dispatchEvent(new Event(EVAL_CRITERIA_CHANGED));
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
      return;
    }
    await launch();
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

        {estimate.backgroundable ? (
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
        ) : (
          <>
            <p className="mt-2 font-medium text-zinc-800 dark:text-zinc-200">
              Keep this tab open for the whole run — it can&apos;t go to the background.
            </p>
            {blocked && (
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">{blocked.reason}</p>
            )}
            {fix && <p className="mt-2 text-zinc-600 dark:text-zinc-400">{fix.note}</p>}
          </>
        )}

        {error && <p className="mt-3 text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
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
            className={
              // The only way forward in the warn-only case, so it is the primary
              // button there and the secondary one when a background exists.
              estimate.backgroundable
                ? "cursor-pointer rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                : "cursor-pointer rounded bg-black px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            }
          >
            Run here
          </button>
          {estimate.backgroundable && (
            <button
              type="button"
              onClick={launch}
              disabled={busy}
              className="cursor-pointer rounded bg-black px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {busy ? "Starting…" : "Run in the background"}
            </button>
          )}
          {!estimate.backgroundable && fix && (
            <button
              type="button"
              onClick={applyFixAndLaunch}
              disabled={busy}
              title={fix.note}
              className="cursor-pointer rounded border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {busy ? "Starting…" : fix.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
