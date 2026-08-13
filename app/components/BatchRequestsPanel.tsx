// JOBS PANEL (Client Component) — the account-wide status view for work that is
// running somewhere other than the tab you are looking at. Mounted in the Nav so
// it's reachable from every config view; each row is tagged with the config that
// launched it, since neither kind of job is scoped to the tab you are on.
//
// TWO SOURCES, ONE PANEL, deliberately:
//
//   • PROVIDER BATCHES (batch_jobs) — work handed to Anthropic/OpenAI/Voyage's
//     batch APIs, which we poll and then apply.
//   • BACKGROUND JOBS (background_jobs) — our own long bulk actions, sliced across
//     invocations so they survive a closed tab and a function timeout.
//
// They are different mechanisms, but from where the user stands they are the same
// question — "what is still running, and did it finish?" — so splitting them
// across two panels would mean checking two places for one answer.
//
// The background half's poll ALSO acts as the janitor: POST /api/jobs/poll nudges
// any job whose chain broke. That makes having the app open the primary recovery
// mechanism, which is the honest design on a host where cron fires once a day.
//
//   • On mount: GET both lists (seeds the badge). If either still has work, do ONE
//     poll, so a batch that finished — or a background job whose chain broke —
//     while the app was closed is picked up straight away.
//   • Always: poll every 60s, advancing provider status, applying completions,
//     sending the completion email, and reviving stalled background jobs. There is
//     no minute-granularity cron, so this loop is the app's real scheduler.
//   • On open: ack every finished job, then poll every 10s while it stays open.
//   • Per row: cancel what can be cancelled, resume a stalled background job, and
//     dismiss a finished one's badge.
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/http/client";
import { JOB_LABELS, isCancelable, isTerminal, type BatchJob } from "@/lib/batch/types";
import {
  JOB_LABELS as BG_JOB_LABELS,
  JOB_UNITS,
  isCancellable as isBgCancellable,
  isStalled as isBgStalled,
  isTerminal as isBgTerminal,
  progressPercent,
  type BackgroundJob,
} from "@/lib/jobs/types";

const OPEN_POLL_MS = 10_000;
// The background cadence, which runs on every page because the panel is in the
// Nav. A minute is the compromise: a batch is a minutes-to-hours affair, so this
// is fast enough that a completion is applied promptly, and slow enough that an
// idle tab isn't hammering the provider's API on the user's own key.
const BACKGROUND_POLL_MS = 60_000;

const STATUS_STYLE: Record<string, string> = {
  submitting: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  applied: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  cancelling: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  expired: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// The background half's row: a progress bar, and the two things a user can do to a
// job they cannot see running — stop it, or push it along when its chain broke.
function BackgroundJobRow({
  job,
  now,
  onAct,
}: {
  job: BackgroundJob;
  // Passed in rather than read from the clock here: rendering must not depend on
  // Date.now(), or the first client render disagrees with the server's and React
  // (rightly) calls the component impure. The panel owns the ticking clock.
  now: number;
  onAct: (id: string, action: "cancel" | "resume" | "acknowledge") => void;
}) {
  const pct = progressPercent(job);
  const unit = JOB_UNITS[job.kind] ?? "unit";
  // "Stalled" is only worth surfacing on a job that has been unattended for a
  // while: between two slices every job is briefly leaseless, and calling that
  // stuck would cry wolf on every healthy handoff. `now` is 0 until the first
  // client tick, which makes both halves false — so a fresh render never accuses a
  // healthy job of being stuck.
  const stalled = isBgStalled(job, now) && now - new Date(job.updatedAt).getTime() > 60_000;
  return (
    <li className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">
          {BG_JOB_LABELS[job.kind] ?? job.kind}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            STATUS_STYLE[job.status] ?? STATUS_STYLE.submitting
          }`}
        >
          {stalled && !isBgTerminal(job.status) ? "stalled" : job.status}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="truncate">{job.configLabel}</span>
        <span className="shrink-0">{ago(job.createdAt)}</span>
      </div>

      {!isBgTerminal(job.status) && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full bg-blue-500 transition-[width] duration-500"
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      <div className="mt-0.5 text-xs text-zinc-500">
        {job.doneUnits.toLocaleString()}
        {job.totalUnits > 0 && ` of ${job.totalUnits.toLocaleString()}`} {unit}
        {job.doneUnits === 1 ? "" : "s"}
        {pct !== null && !isBgTerminal(job.status) && ` · ${pct}%`}
        {job.emailSent && " · emailed"}
      </div>
      {job.error && (
        <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400" title={job.error}>
          {job.error}
        </p>
      )}

      <div className="mt-1 flex gap-2">
        {isBgCancellable(job.status) && (
          <button
            type="button"
            onClick={() => onAct(job.id, "cancel")}
            title="Stops at the next checkpoint; everything processed so far is kept"
            className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        )}
        {stalled && !isBgTerminal(job.status) && (
          <button
            type="button"
            onClick={() => onAct(job.id, "resume")}
            title="Nudge it along — safe at any time; a job that is really running ignores this"
            className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Resume
          </button>
        )}
        {isBgTerminal(job.status) && !job.acknowledged && (
          <button
            type="button"
            onClick={() => onAct(job.id, "acknowledge")}
            className="rounded border border-zinc-300 px-2 py-0.5 text-[11px] cursor-pointer hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}

export function BatchRequestsPanel() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [bgJobs, setBgJobs] = useState<BackgroundJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The clock the "stalled" badge is judged against. Starts at 0 so the first
  // render is deterministic (see BackgroundJobRow), then ticks while mounted.
  const [now, setNow] = useState(0);

  // Deferred out of the effect body (a 0ms timer) for the same reason the open-kick
  // below is: setting state synchronously in an effect cascades a render, and the
  // clock is not worth one.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  const list = useCallback(async (): Promise<BatchJob[]> => {
    const res = await apiFetch("/api/batch");
    const data = (await res.json().catch(() => null)) as { jobs?: BatchJob[]; error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? `Failed to load (${res.status}).`);
    return data?.jobs ?? [];
  }, []);

  // Both sources, in parallel, and INDEPENDENTLY fatal: a provider outage that
  // breaks the batch poll must not also hide the background jobs, which are ours
  // and are fine. Hence two try/catches rather than one Promise.all.
  const checkNow = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const batches = (async () => {
      try {
        const res = await apiFetch("/api/batch/poll", { method: "POST" });
        const data = (await res.json().catch(() => null)) as {
          jobs?: BatchJob[];
          error?: string;
        } | null;
        if (!res.ok) throw new Error(data?.error ?? `Poll failed (${res.status}).`);
        setJobs(data?.jobs ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Network error.");
      }
    })();
    // This poll is also the janitor sweep — see the header.
    const background = (async () => {
      try {
        const res = await apiFetch("/api/jobs/poll", { method: "POST" });
        const data = (await res.json().catch(() => null)) as {
          jobs?: BackgroundJob[];
          error?: string;
        } | null;
        if (!res.ok) throw new Error(data?.error ?? `Poll failed (${res.status}).`);
        setBgJobs(data?.jobs ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Network error.");
      }
    })();
    await Promise.all([batches, background]);
    setBusy(false);
  }, []);

  async function actOnBackground(
    id: string,
    action: "cancel" | "resume" | "acknowledge",
  ) {
    try {
      const res = await apiFetch(`/api/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => null)) as {
        job?: BackgroundJob;
        error?: string;
      } | null;
      if (!res.ok || !data?.job) {
        setErr(data?.error ?? `Action failed (${res.status}).`);
        return;
      }
      const updated = data.job;
      setBgJobs((js) => js.map((j) => (j.id === updated.id ? updated : j)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
    }
  }

  // Mount seed: list both sources, then one poll iff either still has work. Two
  // plain GETs are cheap; the poll they may trigger is not (it talks to providers
  // and revives jobs), so it stays conditional.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [batches, res] = await Promise.all([list(), apiFetch("/api/jobs")]);
        const bg = ((await res.json().catch(() => null)) as { jobs?: BackgroundJob[] } | null)
          ?.jobs ?? [];
        if (!alive) return;
        setJobs(batches);
        setBgJobs(bg);
        const pending =
          batches.some((j) => !isTerminal(j.status)) || bg.some((j) => !isBgTerminal(j.status));
        if (pending) void checkNow();
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "Network error.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [list, checkNow]);

  // Opening the panel IS seeing the finished jobs, so the green dot clears
  // then — acked on the server (POST /api/batch/ack) rather than with a local
  // "seen" flag, so it doesn't come back on the next reload. Best-effort: a
  // failed ack leaves the dot up, which is the safe direction.
  const ackAll = useCallback(async () => {
    try {
      const res = await apiFetch("/api/batch/ack", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { acknowledged?: string[] } | null;
      if (!res.ok || !data?.acknowledged?.length) return;
      const acked = new Set(data.acknowledged);
      setJobs((js) => js.map((j) => (acked.has(j.id) ? { ...j, acknowledged: true } : j)));
    } catch {
      /* leave the badge up — it clears on the next open */
    }
  }, []);

  // Poll on an interval FOR AS LONG AS THIS IS MOUNTED — which, since the panel
  // lives in the Nav, is every page. Fast while open so the list feels live; every
  // minute in the background so a batch completing while you are elsewhere still gets
  // advanced, applied and emailed. There is no server-side scheduler, so this loop is
  // the only thing that ever calls apply().
  //
  // Deliberately NOT gated on a poll already being in flight. /api/batch/poll is
  // idempotent per job, so an overlap costs a duplicate request and nothing else —
  // whereas skipping the tick means one slow or hung poll silently stops the loop,
  // which is the failure that leaves a finished batch unapplied indefinitely.
  useEffect(() => {
    // Opening the panel acks the finished jobs, then polls immediately.
    // Deferred out of the effect body (a 0ms timer) so it doesn't set state
    // synchronously during the effect (which would cascade renders). No kick on
    // the background cadence — the mount seed above already covers "what
    // finished while the app was closed".
    //
    // Ack BEFORE the poll, not alongside it: the poll re-lists from the DB, so a
    // concurrent ack that commits second would be overwritten by rows still
    // reading acknowledged=false and the dot would flash back on.
    const kick = open ? setTimeout(() => void ackAll().then(() => checkNow()), 0) : null;
    const id = setInterval(() => void checkNow(), open ? OPEN_POLL_MS : BACKGROUND_POLL_MS);
    return () => {
      if (kick) clearTimeout(kick);
      clearInterval(id);
    };
  }, [open, checkNow, ackAll]);

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

  // The badge counts BOTH kinds — it answers "is anything running?", and a user
  // who launched a background re-score should see it there without having to know
  // which mechanism ran it.
  const active =
    jobs.filter((j) => !isTerminal(j.status)).length +
    bgJobs.filter((j) => !isBgTerminal(j.status)).length;
  const doneUnacked =
    jobs.filter((j) => isTerminal(j.status) && !j.acknowledged).length +
    bgJobs.filter((j) => isBgTerminal(j.status) && !j.acknowledged).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Jobs: background runs and batch requests — status, cancellations, results"
        className="relative rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Jobs
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
                Jobs
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

            {bgJobs.length > 0 && (
              <>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                  Running in the background
                </p>
                <ul className="mb-3 flex flex-col gap-2">
                  {bgJobs.map((job) => (
                    <BackgroundJobRow
                      key={job.id}
                      job={job}
                      now={now}
                      onAct={(id, action) => void actOnBackground(id, action)}
                    />
                  ))}
                </ul>
              </>
            )}

            {jobs.length > 0 && bgJobs.length > 0 && (
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                Batch requests
              </p>
            )}

            {jobs.length === 0 && bgJobs.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-400">
                Nothing running. Long bulk actions offer to run in the background; provider
                batches appear here once a Batch API option is on in Settings → Savings.
              </p>
            ) : jobs.length === 0 ? null : (
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
