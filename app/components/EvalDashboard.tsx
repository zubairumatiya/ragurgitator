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
  ExplainChunk,
  QuestionDetail,
  QuestionExplain,
} from "@/lib/rag/evalStore";
import type { ChunkWindow, EvalEvent, RechunkResult } from "@/lib/rag/eval";

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
                              <ExplainPanel
                                questionId={q.questionId}
                                state={explains[q.questionId]}
                                k={summary.k}
                              />
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
function ExplainPanel({
  questionId,
  state,
  k,
}: {
  questionId: string;
  state: ExplainState | undefined;
  k: number;
}) {
  // Which retrieved chunks are expanded (keyed by chunk id). Resets when the
  // panel unmounts on collapse — top-k starts collapsed each time it opens.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!state || state.status === "loading") {
    return <p className="mt-1 text-xs text-zinc-400">Loading chunk detail…</p>;
  }
  if (state.status === "error") {
    return <p className="mt-1 text-xs text-red-600 dark:text-red-400">{state.message}</p>;
  }

  const { expected, between, retrieved } = state.data;
  const scored = retrieved.length > 0;
  const expectedInTopK = retrieved.some((c) => c.isExpected);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  // The ground-truth chunk's current standing, to compare against an experiment.
  // On a miss it's on `expected`; on a hit it sits in the retrieved list.
  const hitRow = retrieved.find((c) => c.isExpected);
  const baseline =
    expected?.rank != null
      ? { rank: expected.rank, score: expected.score }
      : hitRow
        ? { rank: hitRow.rank, score: hitRow.score }
        : null;

  // Range label for the gap section, e.g. "ranks 6–22" (or "rank 6" for one).
  const gapLo = k + 1;
  const gapHi = (expected?.rank ?? k + 1) - 1;

  return (
    <div className="mt-1 flex flex-col gap-3 text-xs">
      {/* Only when the ground-truth chunk isn't in the top-k list below. */}
      {!expectedInTopK && (
        <div className="flex flex-col gap-1">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Expected · <span className="font-mono normal-case">{expected?.fileName ?? "?"}</span> · chunk #{expected?.position ?? "?"}
            {scored && ` · not in top ${k}`}
            {expected?.rank != null && (
              <span className="text-zinc-400"> · rank #{expected.rank}</span>
            )}
            {expected?.score != null && (
              <span className="text-zinc-400"> · sim {expected.score.toFixed(3)}</span>
            )}
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
            {retrieved.map((c) => (
              <ChunkRow
                key={c.chunkId}
                chunk={c}
                isOpen={open[c.chunkId] ?? false}
                onToggle={() => toggle(c.chunkId)}
              />
            ))}
          </ol>
        )}
      </div>

      {/* The gap: chunks ranked between the cut-off and the expected chunk (miss only) */}
      {between.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Between · {gapLo === gapHi ? `rank ${gapLo}` : `ranks ${gapLo}–${gapHi}`}
          </span>
          <ol className="flex flex-col gap-1">
            {between.map((c) => (
              <ChunkRow
                key={c.chunkId}
                chunk={c}
                isOpen={open[c.chunkId] ?? false}
                onToggle={() => toggle(c.chunkId)}
              />
            ))}
          </ol>
        </div>
      )}

      {/* What-if: re-chunk this one chunk and re-rank (ephemeral, nothing saved) */}
      <RechunkExperiment
        questionId={questionId}
        baseline={baseline}
        k={k}
        positionHint={expected?.position ?? 0}
      />
    </div>
  );
}

// Ephemeral per-chunk "what-if". One button that opens an experiment with two
// modes — Uniform sub-divide (mode A) or Resize one custom chunk (mode B).
// Nothing is persisted; the live index and the question's stored score are safe.
function RechunkExperiment({
  questionId,
  baseline,
  k,
  positionHint,
}: {
  questionId: string;
  baseline: { rank: number | null; score: number | null } | null;
  k: number;
  positionHint: number;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"uniform" | "custom">("uniform");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded border border-dashed border-zinc-300 px-2 py-1 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900/40"
      >
        Re-chunk this chunk
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-2 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <ModeTab active={mode === "uniform"} onClick={() => setMode("uniform")}>
            Uniform sub-divide
          </ModeTab>
          <ModeTab active={mode === "custom"} onClick={() => setMode("custom")}>
            Resize borders
          </ModeTab>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="cursor-pointer text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          ✕
        </button>
      </div>

      {mode === "uniform" ? (
        <RechunkLab questionId={questionId} baseline={baseline} k={k} />
      ) : (
        <ChunkBoundaryLab
          questionId={questionId}
          baseline={baseline}
          k={k}
          positionHint={positionHint}
        />
      )}
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded px-2 py-1 font-medium ${
        active
          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
          : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

// Shared result view for both modes: before→after headline, per-piece standing,
// and the experiment top-k (this chunk's pieces flagged green). `annotation`
// describes the trial, e.g. "3 pieces @ size 256 / overlap 25" or "custom · 412 tokens".
function RechunkResultView({
  result,
  baseline,
  k,
  annotation,
}: {
  result: RechunkResult;
  baseline: { rank: number | null; score: number | null } | null;
  k: number;
  annotation: string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const before =
    baseline?.rank != null
      ? `#${baseline.rank}${baseline.score != null ? ` · sim ${baseline.score.toFixed(3)}` : ""}`
      : "—";
  const after = result.hit
    ? `hit @ #${result.bestSubRank}`
    : result.bestSubRank != null
      ? `miss · best piece #${result.bestSubRank}`
      : "miss";

  return (
    <div className="flex flex-col gap-2">
      <span className="text-zinc-600 dark:text-zinc-400">
        ground-truth chunk: <span className="font-mono">{before}</span>
        <span className="mx-1 text-zinc-400">→</span>
        <span
          className={`font-mono font-medium ${
            result.hit
              ? "text-green-700 dark:text-green-400"
              : "text-red-700 dark:text-red-400"
          }`}
        >
          {after}
        </span>
        <span className="ml-1 text-zinc-400">({annotation})</span>
      </span>

      <div className="flex flex-col gap-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">Pieces</span>
        <ol className="flex flex-col gap-1">
          {result.subChunks.map((s) => {
            const id = `sub-${s.subIndex}`;
            return (
              <li key={id} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className={`flex cursor-pointer items-center gap-1 text-left hover:underline ${
                    s.inTopK
                      ? "font-medium text-green-700 dark:text-green-400"
                      : "text-zinc-500"
                  }`}
                >
                  <span className="text-zinc-400">{open[id] ? "▾" : "▸"}</span>
                  piece {s.subIndex + 1}/{result.subChunkCount} · rank #{s.rank} · sim{" "}
                  {s.score.toFixed(3)}
                  {s.inTopK && ` · in top ${k} ✓`}
                </button>
                {open[id] && <ChunkText text={s.text} expected={s.inTopK} />}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          Retrieved · top {k} (with this chunk reshaped)
        </span>
        <ol className="flex flex-col gap-1">
          {result.topK.map((c) => {
            const id = `top-${c.rank}`;
            const label = c.isSubChunk
              ? `piece ${(c.subIndex ?? 0) + 1}/${result.subChunkCount}`
              : `${c.fileName ?? "?"} · chunk #${c.position ?? "?"}`;
            return (
              <li key={id} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className={`flex cursor-pointer items-center gap-1 text-left hover:underline ${
                    c.isSubChunk
                      ? "font-medium text-green-700 dark:text-green-400"
                      : "text-zinc-500"
                  }`}
                >
                  <span className="text-zinc-400">{open[id] ? "▾" : "▸"}</span>
                  #{c.rank} · <span className="font-mono">{label}</span> · sim{" "}
                  {c.score.toFixed(3)}
                  {c.isSubChunk && " · this chunk ✓"}
                </button>
                {open[id] && <ChunkText text={c.text} expected={c.isSubChunk} />}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// Mode A — uniform sub-divide (the original experiment): split the chunk at a
// trial size/overlap and re-rank against a corpus where that chunk is swapped
// for its sub-chunks.
function RechunkLab({
  questionId,
  baseline,
  k,
}: {
  questionId: string;
  baseline: { rank: number | null; score: number | null } | null;
  k: number;
}) {
  const [size, setSize] = useState(256);
  const [overlap, setOverlap] = useState(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RechunkResult | null>(null);

  const invalid = !Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size;

  async function run() {
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/eval/questions/${questionId}/rechunk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, overlap }),
      });
      const data = (await res.json()) as RechunkResult | { error: string };
      if (!res.ok || "error" in data) {
        setError("error" in data ? data.error : `Request failed (${res.status}).`);
        setResult(null);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-zinc-500">size (tokens)</span>
          <input
            type="number"
            min={1}
            value={size}
            onChange={(e) => setSize(Math.floor(Number(e.target.value)))}
            className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-zinc-500">overlap (tokens)</span>
          <input
            type="number"
            min={0}
            value={overlap}
            onChange={(e) => setOverlap(Math.floor(Number(e.target.value)))}
            className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        <button
          onClick={run}
          disabled={busy || invalid}
          className="rounded-md bg-black px-3 py-1.5 font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      <span className="text-zinc-400">
        Overlap only affects this chunk’s internal seams — neighbor boundaries
        aren’t re-formed, so size is the higher-signal knob here.
      </span>

      {error && <span className="text-red-600 dark:text-red-400">{error}</span>}

      {result && (
        <RechunkResultView
          result={result}
          baseline={baseline}
          k={k}
          annotation={`${result.subChunkCount} piece${result.subChunkCount === 1 ? "" : "s"} @ size ${size} / overlap ${overlap}`}
        />
      )}
    </div>
  );
}

// Mode B — resize one custom chunk. Stitches the labeled chunk + frozen neighbors
// into contiguous text, lets the user set the chunk's [start, end) token borders
// (numeric for now; drag later), warns when the borders leave document text
// uncovered (a gap), then re-ranks with that one reshaped chunk. Ephemeral.
function ChunkBoundaryLab({
  questionId,
  baseline,
  k,
  positionHint,
}: {
  questionId: string;
  baseline: { rank: number | null; score: number | null } | null;
  k: number;
  positionHint: number;
}) {
  const [range, setRange] = useState<{ from: number; to: number }>(() => ({
    from: Math.max(0, positionHint - 2),
    to: positionHint + 2,
  }));
  const [win, setWin] = useState<ChunkWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [winError, setWinError] = useState<string | null>(null);

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);

  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RechunkResult | null>(null);

  // (Re)fetch the window when the range changes. Widening shifts token indices,
  // so the selection resets to the chunk's own span on each load. Keeping the
  // prior window visible during a refetch avoids a flash back to "Loading…".
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(
          `/api/eval/questions/${questionId}/window?from=${range.from}&to=${range.to}`,
        );
        const data = (await res.json()) as ChunkWindow | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setWinError("error" in data ? data.error : `Request failed (${res.status}).`);
          return;
        }
        setWinError(null);
        setWin(data);
        setStart(data.testDefault.tokenStart);
        setEnd(data.testDefault.tokenEnd);
      } catch (err) {
        if (alive) setWinError(err instanceof Error ? err.message : "Failed to load window.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [questionId, range.from, range.to]);

  if (loading && !win) return <span className="text-zinc-400">Loading window…</span>;
  if (winError) return <span className="text-red-600 dark:text-red-400">{winError}</span>;
  if (!win) return null;

  const { offsets, tokenCount, exclusive, text } = win;
  const clampedStart = Math.max(0, Math.min(start, tokenCount));
  const clampedEnd = Math.max(0, Math.min(end, tokenCount));
  const validSel = clampedStart < clampedEnd;
  const off = (t: number) => offsets[Math.max(0, Math.min(t, tokenCount))];

  // Gap = exclusive-zone tokens not covered by [start, end); overlap = how far the
  // selection reaches into the frozen neighbors.
  const exLen = Math.max(0, exclusive.tokenEnd - exclusive.tokenStart);
  const exCovered = Math.max(
    0,
    Math.min(clampedEnd, exclusive.tokenEnd) - Math.max(clampedStart, exclusive.tokenStart),
  );
  const gapTokens = exLen - exCovered;
  const intoNeighbors =
    Math.max(0, exclusive.tokenStart - clampedStart) +
    Math.max(0, clampedEnd - exclusive.tokenEnd);

  async function run() {
    if (!validSel) return;
    setBusy(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/eval/questions/${questionId}/rechunk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: [text.slice(off(clampedStart), off(clampedEnd))] }),
      });
      const data = (await res.json()) as RechunkResult | { error: string };
      if (!res.ok || "error" in data) {
        setRunError("error" in data ? data.error : `Request failed (${res.status}).`);
        setResult(null);
        return;
      }
      setResult(data);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  // Split the window text into colored bands: selected (the test chunk), gap
  // (uncovered exclusive zone), or context (frozen neighbors). Breakpoints are the
  // selection + exclusive-zone char offsets, so every segment is wholly one kind.
  const sStart = off(clampedStart);
  const sEnd = off(clampedEnd);
  const exStartChar = off(exclusive.tokenStart);
  const exEndChar = off(exclusive.tokenEnd);
  const marks = Array.from(
    new Set([0, text.length, sStart, sEnd, exStartChar, exEndChar]),
  ).sort((a, b) => a - b);
  const segments: { text: string; kind: "sel" | "gap" | "ctx" }[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (b <= a) continue;
    const selected = validSel && a >= sStart && b <= sEnd;
    const inExclusive = a >= exStartChar && b <= exEndChar;
    segments.push({ text: text.slice(a, b), kind: selected ? "sel" : inExclusive ? "gap" : "ctx" });
  }

  const canLoadMore = win.rangeFrom > 0 || win.rangeTo < win.totalChunks - 1;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-zinc-500">
        chunk #{win.testPosition} of {win.totalChunks} · window #{win.rangeFrom}–#{win.rangeTo} ·{" "}
        {tokenCount} tokens. Neighbors are frozen; this chunk’s exclusive zone is tokens{" "}
        {exclusive.tokenStart}–{exclusive.tokenEnd}.
      </span>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-zinc-500">start (token)</span>
          <input
            type="number"
            min={0}
            max={tokenCount}
            value={start}
            onChange={(e) => setStart(Math.floor(Number(e.target.value)))}
            className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-zinc-500">end (token)</span>
          <input
            type="number"
            min={0}
            max={tokenCount}
            value={end}
            onChange={(e) => setEnd(Math.floor(Number(e.target.value)))}
            className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
          />
        </label>
        <button
          onClick={run}
          disabled={busy || !validSel}
          className="rounded-md bg-black px-3 py-1.5 font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-400">
          {validSel ? `${clampedEnd - clampedStart} tokens selected` : "start must be below end"}
        </span>
        {gapTokens > 0 && (
          <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700 dark:bg-red-900/40 dark:text-red-400">
            ⚠ {gapTokens} token{gapTokens === 1 ? "" : "s"} uncovered
          </span>
        )}
        {intoNeighbors > 0 && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            +{intoNeighbors} overlapping neighbors
          </span>
        )}
      </div>

      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 bg-zinc-50 p-2 font-mono leading-relaxed dark:border-zinc-800 dark:bg-zinc-900/40">
        {segments.map((seg, i) => (
          <span
            key={i}
            className={
              seg.kind === "sel"
                ? "bg-indigo-200/70 text-zinc-900 dark:bg-indigo-500/30 dark:text-zinc-100"
                : seg.kind === "gap"
                  ? "bg-red-200/70 text-zinc-900 dark:bg-red-500/30 dark:text-zinc-100"
                  : "text-zinc-400"
            }
          >
            {seg.text}
          </span>
        ))}
      </pre>

      <div className="flex items-center gap-3 text-zinc-500">
        <span>
          <span className="rounded bg-indigo-200/70 px-1 dark:bg-indigo-500/30">selected</span>{" "}
          <span className="rounded bg-red-200/70 px-1 dark:bg-red-500/30">gap</span>{" "}
          <span className="text-zinc-400">frozen neighbor</span>
        </span>
        {canLoadMore && (
          <button
            type="button"
            onClick={() =>
              setRange({
                from: Math.max(0, win.rangeFrom - 2),
                to: Math.min(win.totalChunks - 1, win.rangeTo + 2),
              })
            }
            className="cursor-pointer text-zinc-600 hover:underline dark:text-zinc-300"
          >
            Load more context
          </button>
        )}
      </div>

      {runError && <span className="text-red-600 dark:text-red-400">{runError}</span>}

      {result && (
        <RechunkResultView
          result={result}
          baseline={baseline}
          k={k}
          annotation={`custom · ${clampedEnd - clampedStart} tokens${gapTokens > 0 ? `, ${gapTokens} uncovered` : ""}`}
        />
      )}
    </div>
  );
}

// One retrieved/in-between chunk: a collapsed header (rank · file · chunk # · sim,
// green when it's the ground truth) that expands to the chunk text on click.
function ChunkRow({
  chunk,
  isOpen,
  onToggle,
}: {
  chunk: ExplainChunk;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={`flex cursor-pointer items-center gap-1 text-left hover:underline ${
          chunk.isExpected
            ? "font-medium text-green-700 dark:text-green-400"
            : "text-zinc-500"
        }`}
      >
        <span className="text-zinc-400">{isOpen ? "▾" : "▸"}</span>
        #{chunk.rank} · <span className="font-mono">{chunk.fileName ?? "?"}</span> · chunk #{chunk.position ?? "?"}
        {chunk.score !== null && (
          <span className="text-zinc-400"> · sim {chunk.score.toFixed(3)}</span>
        )}
        {chunk.isExpected && " · ground truth ✓"}
      </button>
      {isOpen && <ChunkText text={chunk.text} expected={chunk.isExpected} />}
    </li>
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
