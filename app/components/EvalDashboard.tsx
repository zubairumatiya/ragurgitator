// ---------------------------------------------------------------------------
// UI: retrieval eval dashboard (/eval).
//
// Shows Recall@k for the active config, a per-document breakdown, the run
// history, and a per-question detail table with inline editing. The "Process
// new chunks" button generates + scores only new/edited questions.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import type { EvalSummary } from "@/lib/rag/evalStore";

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

export function EvalDashboard() {
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // Bump to re-fetch the summary (used after process / edit / delete).
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/eval");
        const data = (await res.json()) as EvalSummary | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setError("error" in data ? data.error : `Request failed (${res.status}).`);
          return;
        }
        setError(null);
        setSummary(data);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Network error.");
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function onProcess() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/eval/process", { method: "POST" });
      const data = (await res.json()) as
        | { generated: number; scored: number; recall: number | null }
        | { error: string };
      if (!res.ok || "error" in data) {
        setError("error" in data ? data.error : `Request failed (${res.status}).`);
        return;
      }
      setNotice(
        `Generated ${data.generated} question(s), scored ${data.scored}. Recall@k = ${pct(data.recall)}.`,
      );
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/eval/questions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      setEditingId(null);
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/eval/questions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onProcess}
          disabled={busy}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Processing…" : "Process new chunks"}
        </button>
        {notice && <span className="text-sm text-zinc-600 dark:text-zinc-400">{notice}</span>}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {summary === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Headline metric */}
          <div className="flex flex-wrap gap-4">
            <Stat label={`Recall@${summary.k}`} value={pct(summary.recall)} big />
            <Stat label="Questions" value={String(summary.total)} />
            <Stat label="Scored" value={String(summary.scored)} />
            <Stat label="Hits" value={String(summary.hits)} />
          </div>

          {summary.total === 0 && (
            <p className="text-sm text-zinc-500">
              No eval questions yet. Ingest a document, then click “Process new chunks”.
            </p>
          )}

          {/* Per-document breakdown */}
          {summary.perDocument.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                By document
              </h2>
              <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {summary.perDocument.map((d) => (
                  <li
                    key={d.documentId}
                    className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                  >
                    <span className="truncate font-mono">{d.fileName}</span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {d.hits}/{d.scored} · {pct(d.scored > 0 ? d.hits / d.scored : null)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Run history */}
          {summary.runs.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Runs
              </h2>
              <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {summary.runs.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                  >
                    <span className="text-zinc-500">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                    <span className="shrink-0 font-medium">
                      {pct(r.questionCount > 0 ? r.hitCount / r.questionCount : null)}
                      <span className="ml-2 text-xs font-normal text-zinc-500">
                        ({r.hitCount}/{r.questionCount} @ k={r.k})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Question detail */}
          {summary.questions.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Questions
              </h2>
              <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {summary.questions.map((q) => (
                  <li key={q.questionId} className="flex flex-col gap-1 px-3 py-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      {editingId === q.questionId ? (
                        <input
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
                          autoFocus
                        />
                      ) : (
                        <span className="flex-1">{q.question}</span>
                      )}
                      <Badge hit={q.hit} rank={q.foundRank} />
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
                      <span className="truncate font-mono">
                        {q.fileName} · chunk #{q.expectedPosition ?? "?"}
                        {q.source === "manual" && " · edited"}
                      </span>
                      <span className="flex shrink-0 gap-2">
                        {editingId === q.questionId ? (
                          <>
                            <button
                              onClick={() => saveEdit(q.questionId)}
                              disabled={busy}
                              className="text-zinc-700 hover:underline disabled:opacity-50 dark:text-zinc-300"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="hover:underline"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setEditingId(q.questionId);
                                setEditText(q.question);
                              }}
                              className="hover:underline"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => remove(q.questionId)}
                              disabled={busy}
                              className="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={big ? "text-2xl font-semibold" : "text-lg font-medium"}>{value}</span>
    </div>
  );
}

function Badge({ hit, rank }: { hit: boolean | null; rank: number | null }) {
  if (hit === null) {
    return <span className="shrink-0 text-xs text-zinc-400">unscored</span>;
  }
  if (hit) {
    return (
      <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-400">
        hit{rank ? ` @${rank}` : ""}
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
      miss
    </span>
  );
}
