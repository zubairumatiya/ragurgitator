// UI: the "Auto-resolve below min-rate" button + its modal.
//
// The button is enabled only when at least one enabled metric has a min-rate.
// Clicking opens a confirm dialog (below-bar count + cost warning); Run drives the
// streamed POST /api/eval/autotune, rendering live per-chunk progress in the same
// modal. Chunks where MORE than one candidate family cleared (apply mode 'choose')
// come back as chunk-choice events — rendered as pickers whose Apply buttons hit
// POST /api/eval/autotune/apply. Closing after a run reloads the dashboard.
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/http/client";
import { BackgroundOfferDialog, type Estimate } from "@/app/components/BackgroundOfferDialog";
import { leftWork } from "@/lib/jobs/steps/autotuneSlice";
import type {
  AutotuneCandidate,
  AutotuneEvent,
  AutotuneStopReason,
} from "@/lib/rag/autotune";
import { failsBar } from "@/lib/rag/evalBar";
import type { EvalSummary } from "@/lib/rag/evalStore";

// Confirm-dialog preview of the engine's targeting: fresh below-bar questions,
// ignored ones excluded (shared D1 rule — lib/rag/evalBar), restricted to the
// chunk scope when one is set (0025) — mirroring runAutotune's target filter.
function belowBarCount(summary: EvalSummary): number {
  const scope =
    summary.criteria.autotune.chunkScope === null
      ? null
      : new Set(summary.criteria.autotune.chunkScope);
  return summary.questions.filter(
    (q) =>
      (scope === null || scope.has(q.sourceChunkId)) && failsBar(q, summary.criteria),
  ).length;
}

function candidateLabel(c: AutotuneCandidate): string {
  if (c.family === "size") return `re-split at ${c.size} tokens`;
  if (c.family === "model") return `re-embed under ${c.model}`;
  return `re-split at ${c.size} tokens under ${c.model}`;
}

type PendingChoice = {
  chunkId: string;
  fileName: string;
  position: number | null;
  candidates: AutotuneCandidate[];
  appliedFamily: string | null; // family applied via the picker, or null
  applying: boolean;
  error: string | null;
};

type Progress =
  | { phase: "search"; chunkIndex: number; chunkTotal: number; detail: string; attempts: number }
  | { phase: "rescore"; done: number; total: number };

type DoneStats = {
  // The sweep ended short: the counts below are real, they just cover the chunks
  // it reached. Nothing is rolled back — see the summary line for how that is
  // said out loud.
  stopReason: AutotuneStopReason | null;
  chunksSearched: number;
  chunksTotal: number;
  targeted: number;
  resolved: number;
  unresolved: number;
  improved: number;
  pendingChoice: number;
  attempts: number;
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
  durationMs: number;
};

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// The lead sentence of the summary. A run that stopped short must not be
// readable as a finished sweep: `resolved/targeted` counts questions on chunks it
// never searched, so the coverage goes FIRST and the next action is spelled out.
// 'early' is the exception — it stopped because the bars were met, which is a
// success and needs no "run again". The default arm has to handle a short run
// too: a run can leave chunks unvisited with no stop reason at all.
function summaryLead(done: DoneStats): string {
  const covered = `${done.chunksSearched} of ${done.chunksTotal} chunk(s)`;
  const more = canContinue(done) ? " Run again to continue." : "";
  switch (done.stopReason) {
    case "budget":
      return `Paused on the time budget — tuned ${covered}.${more}`;
    case "cancelled":
      return `Cancelled — tuned ${covered}, all kept.${more}`;
    case "early":
      return `Min-rates reached after ${covered}.`;
    case "aborted":
      return `Stopped — the targeting criteria changed mid-run. Tuned ${covered}.${more}`;
    default:
      return canContinue(done) ? `Tuned ${covered}.${more}` : "Done.";
  }
}

// Was there work left on the table? Drives the "Run again" button.
//
// Derived from the counts, not from a list of stop reasons — see leftWork. The
// allowlist this replaced ('budget' || 'cancelled') is precisely how a truncated
// run stayed quiet: a new way to stop short falls off a list silently, and the
// bug that motivated all of this produced no stop reason at all.
const canContinue = (done: DoneStats): boolean => leftWork(done);

export function AutotunePanel({
  summary,
  busy,
  onBusyChange,
  onDone,
}: {
  summary: EvalSummary;
  busy: boolean;
  onBusyChange: (b: boolean) => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  // The run's id (its stream's first line) and whether Cancel has been POSTed.
  // Autotune stops between CHUNKS, so the in-flight chunk's search finishes
  // first — the button says "Cancelling…" rather than implying otherwise.
  const [runId, setRunId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [choices, setChoices] = useState<PendingChoice[]>([]);
  const [done, setDone] = useState<DoneStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The "this will take a while" offer, and the confirmation once one is launched.
  // Autotune is the longest bulk action here, so it is the one most worth handing
  // to a background job — except in apply='choose' mode, which needs this tab; the
  // estimate route answers backgroundable: false for it and no offer appears.
  const [offer, setOffer] = useState<Estimate | null>(null);
  const [launched, setLaunched] = useState<string | null>(null);

  const { recall, mrr, ndcg, autotune } = summary.criteria;
  const hasTarget =
    (recall.enabled && recall.minRate !== null) ||
    (mrr.enabled && mrr.minRate !== null) ||
    (ndcg.enabled && ndcg.minRate !== null);
  const below = belowBarCount(summary);

  function openDialog() {
    setRan(false);
    setProgress(null);
    setLog([]);
    setChoices([]);
    setDone(null);
    setError(null);
    setOffer(null);
    setLaunched(null);
    setOpen(true);
  }

  // Ask the server how long this looks like taking before spending anything, and
  // offer the background when it crosses the threshold. Fails open: a broken ETA
  // runs the sweep the way it has always run rather than standing in the way.
  async function start() {
    try {
      const res = await apiFetch("/api/jobs/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "autotune", scope: {} }),
      });
      if (res.ok) {
        const estimate = (await res.json()) as Estimate;
        if (estimate.offerBackground && estimate.backgroundable) {
          setOffer(estimate);
          return;
        }
      }
    } catch {
      // fall through to running here
    }
    await run();
  }

  function close() {
    if (running) return;
    setOpen(false);
    if (ran) onDone(); // scores/overrides changed — reconcile the dashboard
  }

  const pushLog = (line: string) =>
    setLog((l) => [...l.slice(-199), line]); // bounded, newest last

  async function run() {
    setRunning(true);
    setRan(true);
    onBusyChange(true);
    setError(null);
    setDone(null);
    setRunId(null);
    setCancelling(false);
    // Cleared so a continuation run's log is its own. Pending choices are NOT
    // cleared — they are unapplied decisions the user still owes an answer to.
    setLog([]);
    try {
      const res = await apiFetch("/api/eval/autotune", { method: "POST" });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AutotuneEvent;
          switch (event.type) {
            case "run-started":
              setRunId(event.runId);
              break;
            case "autotune-start":
              pushLog(
                `Targeting ${event.targeted} question(s) across ${event.chunks} chunk(s) ` +
                  `(search: ${event.search}, apply: ${event.apply}).`,
              );
              break;
            case "chunk-start":
              setProgress({
                phase: "search",
                chunkIndex: event.index,
                chunkTotal: event.total,
                detail: `${event.fileName} · chunk #${event.position ?? "?"}`,
                attempts: 0,
              });
              break;
            case "attempt":
              setProgress((p) =>
                p?.phase === "search" ? { ...p, attempts: event.attempts } : p,
              );
              break;
            case "chunk-resolved":
              pushLog(`✓ resolved — ${candidateLabel(event.candidate)}`);
              break;
            case "chunk-improved":
              pushLog(`△ improved (still below bar) — ${candidateLabel(event.candidate)}`);
              break;
            case "chunk-choice":
              pushLog(
                `? ${event.fileName} · chunk #${event.position ?? "?"} — multiple fixes pass, pick one below`,
              );
              setChoices((cs) => [
                ...cs,
                {
                  chunkId: event.chunkId,
                  fileName: event.fileName,
                  position: event.position,
                  candidates: event.candidates,
                  appliedFamily: null,
                  applying: false,
                  error: null,
                },
              ]);
              break;
            case "chunk-unresolved":
              pushLog(`✗ unresolved — ${event.reason}`);
              break;
            case "early-stop":
              pushLog(
                `⏹ min-rates reached — skipped ${event.skippedChunks} remaining chunk(s) to save cost`,
              );
              break;
            case "budget-stop":
              pushLog(
                `⏳ ${formatDuration(event.elapsedMs)} time budget reached — ` +
                  `${event.skippedChunks} chunk(s) not searched yet`,
              );
              break;
            case "rescore-start":
              setProgress({ phase: "rescore", done: 0, total: event.total });
              break;
            case "rescore-progress":
              setProgress({ phase: "rescore", done: event.done, total: event.total });
              break;
            case "autotune-done":
              setDone(event);
              break;
            case "error":
              setError(event.message);
              return;
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setRunning(false);
      setProgress(null);
      setRunId(null);
      setCancelling(false);
      onBusyChange(false);
    }
  }

  // Stop the run after the chunk it is currently searching. Every override
  // already confirmed stays, and the run still does its final re-score and
  // reports — cancelling is a flag, not a rollback (lib/http/cancelRegistry.ts).
  // A `found: false` reply means it had already finished; nothing to report.
  async function cancelRun() {
    if (!runId) return;
    setCancelling(true);
    try {
      await apiFetch("/api/eval/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
    } catch {
      setCancelling(false);
    }
  }

  async function applyChoice(chunkId: string, c: AutotuneCandidate) {
    setChoices((cs) =>
      cs.map((ch) =>
        ch.chunkId === chunkId ? { ...ch, applying: true, error: null } : ch,
      ),
    );
    try {
      const res = await apiFetch("/api/eval/autotune/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chunkId,
          family: c.family,
          size: c.size ?? undefined,
          overlap: c.overlap ?? undefined,
          model: c.model ?? undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        status?: string;
        detail?: string;
        error?: string;
      } | null;
      setChoices((cs) =>
        cs.map((ch) => {
          if (ch.chunkId !== chunkId) return ch;
          if (!res.ok || data?.status === "failed") {
            return {
              ...ch,
              applying: false,
              error: data?.detail ?? data?.error ?? `Request failed (${res.status}).`,
            };
          }
          if (data?.status === "reverted" || data?.status === "skipped") {
            const label = data.status === "skipped" ? "Skipped" : "Reverted";
            return { ...ch, applying: false, error: `${label}: ${data.detail}` };
          }
          return { ...ch, applying: false, appliedFamily: c.family };
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error.";
      setChoices((cs) =>
        cs.map((ch) =>
          ch.chunkId === chunkId ? { ...ch, applying: false, error: message } : ch,
        ),
      );
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={busy || !hasTarget}
        title={
          hasTarget
            ? "Automatically search chunk sizes and embedding models to lift every question below its min-rate. More aggressive targets cost more."
            : "Requires a min-rate on an enabled metric in Settings."
        }
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        ⚙ Auto tune
      </button>

      {open && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 text-sm shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Auto tune</h2>
              <button
                type="button"
                onClick={close}
                disabled={running}
                className="cursor-pointer text-zinc-400 hover:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-zinc-300"
              >
                ✕
              </button>
            </div>

            {!ran && (
              <>
                <p className="text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {below}
                  </span>{" "}
                  question(s)
                  {autotune.chunkScope !== null
                    ? ` on your ${autotune.chunkScope.length} selected chunk(s)`
                    : ""}{" "}
                  are below their min-rate. The search tries chunk sizes
                  first, then embedding models, then combos ({autotune.search ===
                  "exhaustive"
                    ? "best-of-best: every size × model"
                    : "stopping at the first fix"}
                  ; when several fixes pass:{" "}
                  {autotune.apply === "auto_best" ? "auto-apply the best" : "you choose"}).
                </p>
                <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                  ⚠ Higher target rates mean more experiments and embedding usage
                  {autotune.search === "exhaustive"
                    ? " — best-of-best mode multiplies that cost"
                    : ""}
                  . Winning overrides are confirmed through real retrieval and
                  reverted if they regress.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={start}
                    disabled={below === 0}
                    title={below === 0 ? "Nothing is below its min-rate" : undefined}
                    className="cursor-pointer rounded-md bg-black px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
                  >
                    Run autotune
                  </button>
                </div>
              </>
            )}

            {progress && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-zinc-500">
                  {progress.phase === "search"
                    ? `Chunk ${progress.chunkIndex}/${progress.chunkTotal} — ${progress.detail} · ${progress.attempts} experiment(s)`
                    : `Final re-score ${progress.done}/${progress.total}…`}
                </p>
                {/* Stops after the chunk being searched; overrides already
                    confirmed are kept and the final re-score still runs. */}
                {runId && (
                  <button
                    type="button"
                    onClick={cancelRun}
                    disabled={cancelling}
                    title="Stop after the current chunk. Overrides already applied are kept, and the run still re-scores."
                    className="shrink-0 cursor-pointer rounded border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    {cancelling ? "Cancelling…" : "Cancel"}
                  </button>
                )}
              </div>
            )}

            {log.length > 0 && (
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                {log.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}

            {choices.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Pick a fix per chunk
                </p>
                {choices.map((ch) => (
                  <div
                    key={ch.chunkId}
                    className="flex flex-col gap-1.5 rounded border border-zinc-200 px-2 py-1.5 dark:border-zinc-800"
                  >
                    <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {ch.fileName} · chunk #{ch.position ?? "?"}
                    </span>
                    {ch.candidates.map((c) => (
                      <div
                        key={c.family}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span>
                          {candidateLabel(c)}
                          <span className="ml-1 text-zinc-400">
                            (score {c.score.toFixed(2)})
                          </span>
                        </span>
                        {ch.appliedFamily === c.family ? (
                          <span className="text-green-700 dark:text-green-400">
                            applied ✓
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => applyChoice(ch.chunkId, c)}
                            disabled={ch.applying || ch.appliedFamily !== null}
                            className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                          >
                            {ch.applying ? "Applying…" : "Apply"}
                          </button>
                        )}
                      </div>
                    ))}
                    {ch.error && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {ch.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {done && (
              <p className="text-zinc-700 dark:text-zinc-300">
                {summaryLead(done)} {done.resolved}/{done.targeted} resolved
                {done.improved > 0
                  ? `, ${done.improved} improved (still below bar)`
                  : ""}
                {done.pendingChoice > 0
                  ? `, ${done.pendingChoice} awaiting your choice above`
                  : ""}
                , {done.attempts} experiment(s) in {formatDuration(done.durationMs)}. Recall{" "}
                {done.recall === null ? "—" : `${(done.recall * 100).toFixed(1)}%`} · MRR{" "}
                {done.mrr === null ? "—" : done.mrr.toFixed(2)} · nDCG{" "}
                {done.ndcg === null ? "—" : done.ndcg.toFixed(2)}.
              </p>
            )}

            {launched && (
              <p className="rounded border border-green-300 bg-green-50 px-2 py-1.5 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300">
                {launched}
              </p>
            )}

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            {ran && !running && (
              <div className="flex justify-end gap-2">
                {/* A paused or cancelled sweep left chunks unsearched. Targets
                    are recomputed from the current summary, so this simply
                    continues — the chunks already tuned no longer qualify. */}
                {done && canContinue(done) && (
                  <button
                    type="button"
                    onClick={run}
                    className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Run again
                  </button>
                )}
                <button
                  type="button"
                  onClick={close}
                  className="cursor-pointer rounded-md bg-black px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 dark:bg-zinc-50 dark:text-black"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {offer && (
        <BackgroundOfferDialog
          estimate={offer}
          scope={{}}
          onRunHere={() => {
            setOffer(null);
            void run();
          }}
          onLaunched={(message) => {
            setOffer(null);
            // `ran` so closing reconciles the dashboard: the job is already
            // changing overrides and scores behind this modal.
            setRan(true);
            setLaunched(message);
          }}
          onClose={() => setOffer(null)}
        />
      )}
    </>
  );
}
