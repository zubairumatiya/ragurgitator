// ---------------------------------------------------------------------------
// UI: the "Auto-resolve below min-rate" button + its modal (Phase C of
// docs/eval-autotuning-plan.md §4.4).
//
// The button is enabled only when at least one enabled metric has a min-rate.
// Clicking opens a confirm dialog (below-bar count + cost warning); Run drives
// the streamed POST /api/eval/autotune, rendering live per-chunk progress in
// the same modal. Chunks where MORE than one candidate family cleared (apply
// mode 'choose') come back as chunk-choice events — rendered as pickers whose
// Apply buttons hit POST /api/eval/autotune/apply. Closing after a run reloads
// the dashboard.
// ---------------------------------------------------------------------------
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/http/client";
import type { AutotuneCandidate, AutotuneEvent } from "@/lib/rag/autotune";
import { failsBar } from "@/lib/rag/evalBar";
import type { EvalSummary } from "@/lib/rag/evalStore";

// Confirm-dialog preview of the engine's targeting: fresh below-bar questions,
// ignored ones excluded (shared D1 rule — lib/rag/evalBar).
function belowBarCount(summary: EvalSummary): number {
  return summary.questions.filter((q) => failsBar(q, summary.criteria)).length;
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
  targeted: number;
  resolved: number;
  unresolved: number;
  pendingChoice: number;
  attempts: number;
  recall: number | null;
  ndcg: number | null;
};

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
  const [log, setLog] = useState<string[]>([]);
  const [choices, setChoices] = useState<PendingChoice[]>([]);
  const [done, setDone] = useState<DoneStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { recall, ndcg, autotune } = summary.criteria;
  const hasTarget =
    (recall.enabled && recall.minRate !== null) ||
    (ndcg.enabled && ndcg.minRate !== null);
  const below = belowBarCount(summary);

  function openDialog() {
    setRan(false);
    setProgress(null);
    setLog([]);
    setChoices([]);
    setDone(null);
    setError(null);
    setOpen(true);
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
      onBusyChange(false);
    }
  }

  // Apply one picked candidate for a pending-choice chunk.
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
          return data?.status === "reverted"
            ? { ...ch, applying: false, error: `Reverted: ${data.detail}` }
            : { ...ch, applying: false, appliedFamily: c.family };
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
                  question(s) are below their min-rate. The search tries chunk sizes
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
                    onClick={run}
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
              <p className="text-xs text-zinc-500">
                {progress.phase === "search"
                  ? `Chunk ${progress.chunkIndex}/${progress.chunkTotal} — ${progress.detail} · ${progress.attempts} experiment(s)`
                  : `Final re-score ${progress.done}/${progress.total}…`}
              </p>
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
                Done: {done.resolved}/{done.targeted} resolved
                {done.pendingChoice > 0
                  ? `, ${done.pendingChoice} awaiting your choice above`
                  : ""}
                , {done.attempts} experiment(s). Recall{" "}
                {done.recall === null ? "—" : `${(done.recall * 100).toFixed(1)}%`} · nDCG{" "}
                {done.ndcg === null ? "—" : done.ndcg.toFixed(2)}.
              </p>
            )}

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            {ran && !running && (
              <div className="flex justify-end">
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
    </>
  );
}
