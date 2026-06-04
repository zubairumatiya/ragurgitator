// ---------------------------------------------------------------------------
// UI: retrieval eval dashboard (/eval).
//
// Shows Recall@k for the active config, a per-document breakdown, the run
// history, and a per-question detail table with inline editing. The "Process
// new chunks" button generates + scores only new/edited questions.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState } from "react";
import type {
  EvalSummary,
  QuestionDetail,
  QuestionExplain,
} from "@/lib/rag/evalStore";
import type { EvalEvent } from "@/lib/rag/eval";

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

type ChunkGroup = {
  chunkId: string;
  fileName: string;
  position: number | null;
  questions: QuestionDetail[];
};

// Group questions by their labeled chunk, preserving the server's order (document
// order, then oldest-first within a chunk) so groups appear in a stable sequence.
function groupByChunk(questions: QuestionDetail[]): ChunkGroup[] {
  const groups: ChunkGroup[] = [];
  const indexByChunk = new Map<string, number>();
  for (const q of questions) {
    let i = indexByChunk.get(q.sourceChunkId);
    if (i === undefined) {
      i = groups.length;
      indexByChunk.set(q.sourceChunkId, i);
      groups.push({
        chunkId: q.sourceChunkId,
        fileName: q.fileName,
        position: q.expectedPosition,
        questions: [],
      });
    }
    groups[i].questions.push(q);
  }
  return groups;
}

// Live progress for an in-flight process/rescore run. "generate" has no recall
// yet; "score" tracks a running hit count so the panel can show recall climbing.
type EvalProgress =
  | { phase: "generate"; done: number; total: number }
  | { phase: "score"; done: number; total: number; hits: number };

type RunResult = { generated: number; scored: number; recall: number | null };

// Lazy-loaded "why did it miss?" detail for an expanded question.
type ExplainState =
  | { status: "loading" }
  | { status: "ready"; data: QuestionExplain }
  | { status: "error"; message: string };

export function EvalDashboard() {
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<EvalProgress | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // Which question's chunk drill-down is expanded, and the per-question detail
  // we lazy-fetch on first expand (cached so re-opening is instant).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});

  // Inline "add a question" form: which chunk group it's open for, and its text.
  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [addText, setAddText] = useState("");

  // Bump to re-fetch the summary (used after process / edit / delete / add). A
  // reload means questions/scores may have changed, so reset transient UI.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => {
    setExplains({});
    setExpandedId(null);
    setAddingChunkId(null);
    setAddText("");
    setReloadKey((k) => k + 1);
  };

  // Toggle a question's drill-down, fetching its detail the first time it opens.
  function toggleExpand(id: string) {
    const opening = expandedId !== id;
    setExpandedId(opening ? id : null);
    if (!opening || explains[id]) return;
    setExplains((m) => ({ ...m, [id]: { status: "loading" } }));
    fetch(`/api/eval/questions/${id}/explain`)
      .then(async (res) => {
        const data = (await res.json()) as QuestionExplain | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error("error" in data ? data.error : `Request failed (${res.status}).`);
        }
        setExplains((m) => ({ ...m, [id]: { status: "ready", data } }));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Failed to load.";
        setExplains((m) => ({ ...m, [id]: { status: "error", message } }));
      });
  }

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

  // Flip a question's badge in place as its score lands. Only patches rows that
  // are already in the table; brand-new generated questions appear on reload().
  function patchQuestion(id: string, hit: boolean, foundRank: number | null) {
    setSummary((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            questions: prev.questions.map((q) =>
              q.questionId === id
                ? { ...q, hit, foundRank, stale: false, scoredAt: Date.now() }
                : q,
            ),
          },
    );
  }

  // Drive a process/rescore run from its NDJSON event stream: advance the
  // progress bar, patch question badges live, and reconcile via reload() at the end.
  async function runStream(url: string, label: (r: RunResult) => string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    setProgress(null);
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let hits = 0;
      let final: RunResult | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as EvalEvent;
          switch (event.type) {
            case "generate-start":
              setProgress({ phase: "generate", done: 0, total: event.total });
              break;
            case "generate-progress":
              setProgress({ phase: "generate", done: event.done, total: event.total });
              break;
            case "score-start":
              hits = 0;
              setProgress({ phase: "score", done: 0, total: event.total, hits: 0 });
              break;
            case "score-result":
              if (event.hit) hits += 1;
              setProgress({ phase: "score", done: event.done, total: event.total, hits });
              patchQuestion(event.questionId, event.hit, event.foundRank);
              break;
            case "done":
              final = { generated: event.generated, scored: event.scored, recall: event.recall };
              break;
            case "error":
              setError(event.message);
              return;
          }
        }
      }

      if (final) setNotice(label(final));
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const onProcess = () =>
    runStream(
      "/api/eval/process",
      (r) =>
        `Generated ${r.generated} question(s), scored ${r.scored}. Recall@k = ${pct(r.recall)}.`,
    );

  const onRescore = () =>
    runStream(
      "/api/eval/rescore",
      (r) => `Re-scored ${r.scored} question(s). Recall@k = ${pct(r.recall)}.`,
    );

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

  // Add a hand-written question to a chunk. It lands unscored; the next "Process
  // new chunks" / "Re-score all" scores it like any other.
  async function addQuestion(chunkId: string) {
    const text = addText.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/eval/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkId, question: text }),
      });
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

  // Disable the actions when they'd be no-ops. "Process" generates questions for
  // chunks below target and scores unscored/edited ones; "Re-score" re-runs every
  // labeled question. While the summary is still loading we leave them enabled.
  const canProcess =
    summary === null || summary.pendingChunks > 0 || summary.pendingScoring > 0;
  const canRescore = summary === null || summary.total > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onProcess}
          disabled={busy || !canProcess}
          title={
            canProcess
              ? "Generate questions for new chunks and score anything unscored"
              : "Nothing new to process — no new chunks or unscored questions"
          }
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Processing…" : "Process new chunks"}
        </button>
        <button
          onClick={onRescore}
          disabled={busy || !canRescore}
          title={
            canRescore
              ? "Re-run retrieval scoring for every labeled question"
              : "No labeled questions to re-score yet"
          }
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Re-score all
        </button>
        {!progress && notice && (
          <span className="text-sm text-zinc-600 dark:text-zinc-400">{notice}</span>
        )}
      </div>

      {progress && <RunProgress progress={progress} k={summary?.k ?? 0} />}

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

          {/* Question detail, grouped by the chunk each question is labeled to */}
          {summary.questions.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Questions
              </h2>
              <div className="flex flex-col gap-3">
                {groupByChunk(summary.questions).map((group) => {
                  const scored = group.questions.filter(
                    (q) => q.hit !== null && !q.stale,
                  );
                  const hits = scored.filter((q) => q.hit === true).length;
                  return (
                    <div
                      key={group.chunkId}
                      className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
                    >
                      {/* Which chunk these questions belong to */}
                      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <span className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {group.fileName} · chunk #{group.position ?? "?"}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {scored.length > 0
                            ? `${hits}/${scored.length} hit${scored.length === 1 ? "" : "s"}`
                            : "unscored"}
                        </span>
                      </div>

                      <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
                        {group.questions.map((q) => (
                          <li
                            key={q.questionId}
                            className="flex flex-col gap-1 px-3 py-2 text-sm"
                          >
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
                              <Badge hit={q.hit} rank={q.foundRank} stale={q.stale} />
                            </div>
                            <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
                              <span className="font-mono text-zinc-400">
                                {q.source === "manual" ? "manual" : ""}
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                {editingId === q.questionId ? (
                                  <>
                                    <button
                                      onClick={() => saveEdit(q.questionId)}
                                      disabled={busy}
                                      className="cursor-pointer text-zinc-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300"
                                    >
                                      Save
                                    </button>
                                    <button
                                      onClick={() => setEditingId(null)}
                                      className="cursor-pointer hover:underline"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    {/* Retrieval drill-down — only once there's a score to show */}
                                    {q.hit !== null && (
                                      <button
                                        type="button"
                                        onClick={() => toggleExpand(q.questionId)}
                                        title={
                                          expandedId === q.questionId
                                            ? "Hide retrieval detail"
                                            : "Show what retrieval returned for this question"
                                        }
                                        className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                                      >
                                        top-k
                                      </button>
                                    )}
                                    <button
                                      onClick={() => {
                                        setEditingId(q.questionId);
                                        setEditText(q.question);
                                      }}
                                      className="cursor-pointer hover:underline"
                                    >
                                      Edit
                                    </button>
                                    <button
                                      onClick={() => remove(q.questionId)}
                                      disabled={busy}
                                      className="cursor-pointer text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400"
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </span>
                            </div>
                            {expandedId === q.questionId && (
                              <ExplainPanel state={explains[q.questionId]} k={summary.k} />
                            )}
                          </li>
                        ))}
                      </ul>

                      {/* Add a hand-written question to this chunk */}
                      <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
                        {addingChunkId === group.chunkId ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={addText}
                              onChange={(e) => setAddText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") addQuestion(group.chunkId);
                                if (e.key === "Escape") setAddingChunkId(null);
                              }}
                              placeholder="A question this chunk should answer…"
                              className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
                              autoFocus
                            />
                            <button
                              onClick={() => addQuestion(group.chunkId)}
                              disabled={busy || !addText.trim()}
                              className="cursor-pointer text-xs font-medium text-zinc-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300"
                            >
                              Add
                            </button>
                            <button
                              onClick={() => setAddingChunkId(null)}
                              className="cursor-pointer text-xs hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setAddingChunkId(group.chunkId);
                              setAddText("");
                            }}
                            className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
                          >
                            + Add a question
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
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

function Badge({
  hit,
  rank,
  stale,
}: {
  hit: boolean | null;
  rank: number | null;
  stale: boolean;
}) {
  if (hit === null) {
    return <span className="shrink-0 text-xs text-zinc-400">unscored</span>;
  }
  if (stale) {
    return (
      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
        stale
      </span>
    );
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

// The "why did it miss?" drill-down: what retrieval returned in rank order, each
// chunk collapsed to its header and expandable on click. The ground-truth chunk
// is flagged green at its rank when it's in the top-k; when it's NOT (a miss, or
// unscored), it's shown up top on its own since the list won't contain it.
// Lazy-loaded, so it renders loading/error states too.
function ExplainPanel({ state, k }: { state: ExplainState | undefined; k: number }) {
  // Which retrieved chunks are expanded (keyed by chunk id). Resets when the
  // panel unmounts on collapse — top-k starts collapsed each time it opens.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!state || state.status === "loading") {
    return <p className="mt-1 text-xs text-zinc-400">Loading chunk detail…</p>;
  }
  if (state.status === "error") {
    return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{state.message}</p>;
  }

  const { expected, retrieved } = state.data;
  const scored = retrieved.length > 0;
  const expectedInTopK = retrieved.some((c) => c.isExpected);

  return (
    <div className="mt-1 flex flex-col gap-3 text-xs">
      {/* Only when the ground-truth chunk isn't in the list below. */}
      {!expectedInTopK && (
        <div className="flex flex-col gap-1">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Expected · <span className="font-mono normal-case">{expected?.fileName ?? "?"}</span> · chunk #{expected?.position ?? "?"}
            {scored && ` · not in top ${k}`}
          </span>
          <ChunkText text={expected?.text ?? "Chunk text unavailable."} expected />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          Retrieved · top {k}
        </span>
        {!scored ? (
          <span className="text-zinc-400">Not scored yet — no retrieval recorded.</span>
        ) : (
          <ol className="flex flex-col gap-1">
            {retrieved.map((c) => {
              const isOpen = open[c.chunkId] ?? false;
              return (
                <li key={c.chunkId} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [c.chunkId]: !isOpen }))}
                    className={`flex cursor-pointer items-center gap-1 text-left hover:underline ${
                      c.isExpected
                        ? "font-medium text-green-700 dark:text-green-400"
                        : "text-zinc-500"
                    }`}
                  >
                    <span className="text-zinc-400">{isOpen ? "▾" : "▸"}</span>
                    #{c.rank} · <span className="font-mono">{c.fileName ?? "?"}</span> · chunk #{c.position ?? "?"}
                    {c.isExpected && " · ground truth ✓"}
                  </button>
                  {isOpen && <ChunkText text={c.text} expected={c.isExpected} />}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

// A single chunk's text in a scrollable box. The ground-truth chunk gets a green
// tint so it stands out wherever it appears (expected header and, on a hit, in
// the retrieved list).
function ChunkText({ text, expected }: { text: string; expected?: boolean }) {
  const tint = expected
    ? "border-green-300 bg-green-50 dark:border-green-900/50 dark:bg-green-900/15"
    : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40";
  return (
    <pre
      className={`max-h-40 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 ${tint}`}
    >
      {text}
    </pre>
  );
}

// Live run panel: a per-phase bar (Generate, then Score). During scoring it also
// shows a running hit count and Recall@k climbing as results stream in.
function RunProgress({ progress, k }: { progress: EvalProgress; k: number }) {
  const fraction = progress.total > 0 ? progress.done / progress.total : 0;
  const percent = Math.round(fraction * 100);
  const scoring = progress.phase === "score";
  const recall = scoring && progress.done > 0 ? progress.hits / progress.done : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {scoring ? "Scoring questions" : "Generating questions"}{" "}
          <span className="tabular-nums">
            {progress.done}/{progress.total}
          </span>
          {scoring && recall !== null && (
            <span className="ml-2 text-zinc-400">
              · {progress.hits} hit{progress.hits === 1 ? "" : "s"} · Recall@{k}{" "}
              {(recall * 100).toFixed(0)}%
            </span>
          )}
        </span>
        <span className="tabular-nums">{percent}%</span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-zinc-900 transition-all duration-300 dark:bg-zinc-100"
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      </div>
    </div>
  );
}
