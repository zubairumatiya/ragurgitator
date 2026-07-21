// ---------------------------------------------------------------------------
// BATCH REQUESTS PANEL (Client Component) — the account-wide status view for
// batch API jobs, mounted in the Nav next to Settings so it's reachable from
// every config view. Jobs are global (a provider batch isn't config-scoped), so
// each row is tagged with the config that launched it.
//
// Behavior (decision 4 — poll-while-open + Check now):
//   • On mount: GET the list (seeds the badge). If anything is still running, do
//     ONE poll so batches that finished while the app was closed get picked up
//     and applied on this open — bounded to when there's actually pending work.
//   • While open: poll every 10s (advance provider status, apply completions,
//     email once) and re-list. "Check now" forces a poll immediately.
//   • Cancel (in_progress only) and dismiss ("ack") a finished job's badge.
// ---------------------------------------------------------------------------
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/http/client";
import { JOB_LABELS, isCancelable, isTerminal, type BatchJob } from "@/lib/batch/types";

const POLL_MS = 10_000;

const STATUS_STYLE: Record<string, string> = {
  submitting: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  applied: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  canceling: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  canceled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  expired: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function BatchRequestsPanel() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const list = useCallback(async (): Promise<BatchJob[]> => {
    const res = await apiFetch("/api/batch");
    const data = (await res.json().catch(() => null)) as { jobs?: BatchJob[]; error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? `Failed to load (${res.status}).`);
    return data?.jobs ?? [];
  }, []);

  const checkNow = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/batch/poll", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { jobs?: BatchJob[]; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `Poll failed (${res.status}).`);
      setJobs(data?.jobs ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Mount seed: list, then one poll iff something is still running.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const initial = await list();
        if (!alive) return;
        setJobs(initial);
        if (initial.some((j) => !isTerminal(j.status))) void checkNow();
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "Network error.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [list, checkNow]);

  // While open: poll on an interval. The first poll is deferred out of the
  // effect body (a 0ms timer) so it doesn't set state synchronously during the
  // effect (which would cascade renders).
  useEffect(() => {
    if (!open) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    const kick = setTimeout(() => void checkNow(), 0);
    pollRef.current = setInterval(() => void checkNow(), POLL_MS);
    return () => {
      clearTimeout(kick);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, checkNow]);

  async function act(id: string, action: "cancel" | "ack") {
    try {
      const res = await apiFetch(`/api/batch/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => null)) as { job?: BatchJob; error?: string } | null;
      if (!res.ok || !data?.job) {
        setErr(data?.error ?? `Action failed (${res.status}).`);
        return;
      }
      const updated = data.job;
      setJobs((js) => js.map((j) => (j.id === updated.id ? updated : j)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
    }
  }

  const active = jobs.filter((j) => !isTerminal(j.status)).length;
  const doneUnacked = jobs.filter((j) => isTerminal(j.status) && !j.acknowledged).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Batch requests: status, cancellations, results"
        className="relative rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Batches
        {active > 0 && (
          <span className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white">
            {active}
          </span>
        )}
        {doneUnacked > 0 && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-white dark:ring-zinc-900" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 max-h-[70vh] w-96 overflow-y-auto rounded-md border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Batch requests
              </p>
              <button
                type="button"
                onClick={() => void checkNow()}
                disabled={busy}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs cursor-pointer hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {busy ? "Checking…" : "Check now"}
              </button>
            </div>

            {err && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{err}</p>}

            {jobs.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-400">
                No batch requests yet. Turn on a Batch API option in Settings → Savings, then run
                that job.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {jobs.map((job) => (
                  <li
                    key={job.id}
                    className="rounded border border-zinc-200 p-2 dark:border-zinc-800"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">
                        {JOB_LABELS[job.kind] ?? job.kind}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          STATUS_STYLE[job.status] ?? STATUS_STYLE.submitting
                        }`}
                      >
                        {job.status.replace("_", " ")}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-zinc-500">
                      <span className="truncate">
                        {job.configLabel} · {job.provider}
                      </span>
                      <span className="shrink-0">{ago(job.createdAt)}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {job.status === "applied"
                        ? `${job.appliedCount} applied`
                        : `${job.succeededCount}/${job.requestCount} done`}
                      {job.erroredCount > 0 && ` · ${job.erroredCount} errored`}
                    </div>
                    {job.error && (
                      <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400" title={job.error}>
                        {job.error}
                      </p>
                    )}
                    <div className="mt-1 flex gap-2">
                      {isCancelable(job.status) && (
                        <button
                          type="button"
                          onClick={() => void act(job.id, "cancel")}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Cancel
                        </button>
                      )}
                      {isTerminal(job.status) && !job.acknowledged && (
                        <button
                          type="button"
                          onClick={() => void act(job.id, "ack")}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
