// ---------------------------------------------------------------------------
// UI: retrieval eval dashboard (/eval).
//
// Shows Recall@k and nDCG for the active config, a per-document breakdown, the run
// history, and a per-question detail table with inline editing. The "Process
// new chunks" button generates + scores only new/edited questions.
//
// MRR is still computed and stored server-side (it rides the same retrieval pass)
// but isn't surfaced here — Recall@k already covers the in-top-k signal at this
// altitude. It'll resurface in the planned cross-chunk model-comparison rollup,
// where averaging rank over many questions makes it pull its weight.
// ---------------------------------------------------------------------------
"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { HIGH_NDCG } from "@/lib/config";
import { apiFetch } from "@/lib/http/client";
import { failsBar } from "@/lib/rag/evalBar";
import type {
  ChunkOverrideInfo,
  EvalSummary,
  ExplainChunk,
  OverrideOutcome,
  PoolChunk,
  QuestionDetail,
  QuestionExplain,
  SavedModelTrial,
  TrialKind,
  TrialQuestionOutcome,
} from "@/lib/rag/evalStore";
import type {
  ChunkWindow,
  Difficulty,
  EvalEvent,
  ModelTrialContext,
  ModelTrialResult,
  RechunkResult,
} from "@/lib/rag/eval";
import { AutotunePanel } from "@/app/components/AutotunePanel";
import { ConfigChangeDialog } from "@/app/components/ConfigChangeDialog";
import { EVAL_CRITERIA_CHANGED } from "@/app/components/EvalSettings";
import { NdcgRankingPanel } from "@/app/components/NdcgRankingPanel";
import type { IngestedDocument } from "@/lib/rag/vectorStore";

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

// nDCG lands in [0, 1] but isn't a percentage — plain 2-decimal score.
function fmtScore(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}

// Continuous tint for a score in [0, 1], mixing from the miss badge's red to
// the hit badge's green in oklch (passing through amber mid-range), so a
// perfect score is the exact same green as a Recall@k hit. Consumers set the
// --mp custom property with this and reference it from the tint*Class
// arbitrary-value Tailwind classes below, so light/dark variants still apply.
function scoreTint(score: number): CSSProperties {
  const pct = Math.round(100 * Math.min(1, Math.max(0, score)));
  return { "--mp": `${pct}%` } as CSSProperties;
}

const tintBgClass =
  "bg-[color-mix(in_oklch,var(--color-red-100),var(--color-green-100)_var(--mp))] dark:bg-[color-mix(in_oklch,var(--color-red-900),var(--color-green-900)_var(--mp))]/40";
const tintTextClass =
  "text-[color-mix(in_oklch,var(--color-red-700),var(--color-green-700)_var(--mp))] dark:text-[color-mix(in_oklch,var(--color-red-400),var(--color-green-400)_var(--mp))]";

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

type RunResult = {
  generated: number;
  scored: number;
  recall: number | null;
  mrr: number | null;
  ndcg: number | null;
};

// Lazy-loaded "why did it miss?" detail for an expanded question.
type ExplainState =
  | { status: "loading" }
  | { status: "ready"; data: QuestionExplain }
  | { status: "error"; message: string };

export function EvalDashboard() {
  const router = useRouter();
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Bulk actions → Change base model / chunk size" edits THIS config in place
  // (or one document via per-chunk overrides when a document scope is picked).
  const [changeScope, setChangeScope] = useState<{
    docId: string | null;
    docName: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<EvalProgress | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // Which question's chunk drill-down is expanded, and the per-question detail
  // we lazy-fetch on first expand (cached so re-opening is instant).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});

  // Which question's nDCG ranking builder is open (independent of the top-k drill-down).
  const [rankingOpenId, setRankingOpenId] = useState<string | null>(null);

  // Run history is collapsed by default — it grows over time and sits above the
  // questions table, so keep it out of the way until asked for.
  const [runsOpen, setRunsOpen] = useState(false);

  // Inline "add a question" form: which chunk group it's open for, the synthetic
  // vs. manual tab, the manual text, and which difficulty (if any) is generating.
  const [addingChunkId, setAddingChunkId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<"synthetic" | "manual">("synthetic");
  const [addText, setAddText] = useState("");
  const [genDifficulty, setGenDifficulty] = useState<Difficulty | null>(null);

  // Bump to re-fetch the summary (used after process / edit / delete / add). A
  // reload means questions/scores may have changed, so reset transient UI.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => {
    setExplains({});
    setExpandedId(null);
    setRankingOpenId(null);
    setAddingChunkId(null);
    setAddText("");
    setReloadKey((k) => k + 1);
  };

  // The Settings dropdown lives in the Nav now (EvalSettings.tsx); when it
  // saves, re-pull the summary so criteria-dependent numbers refresh.
  useEffect(() => {
    const onChanged = () => setReloadKey((k) => k + 1);
    window.addEventListener(EVAL_CRITERIA_CHANGED, onChanged);
    return () => window.removeEventListener(EVAL_CRITERIA_CHANGED, onChanged);
  }, []);

  // Toggle a question's drill-down, fetching its detail the first time it opens.
  function toggleExpand(id: string) {
    const opening = expandedId !== id;
    setExpandedId(opening ? id : null);
    if (!opening || explains[id]) return;
    setExplains((m) => ({ ...m, [id]: { status: "loading" } }));
    apiFetch(`/api/eval/questions/${id}/explain`)
      .then(async (res) => {
        const data = (await res.json()) as QuestionExplain | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
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
        const res = await apiFetch("/api/eval");
        const data = (await res.json()) as EvalSummary | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setError(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
          return;
        }
        setError(null);
        setSummary(data);
      } catch (err) {
        if (alive)
          setError(err instanceof Error ? err.message : "Network error.");
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // Re-fetch the summary in place (no transient-UI reset), so promoting/editing a
  // ground-truth ranking updates the nDCG chip + headline without collapsing the
  // open ranking panel. Used as the NdcgRankingPanel's onChange.
  async function refreshSummary() {
    try {
      const res = await apiFetch("/api/eval");
      const data = (await res.json()) as EvalSummary | { error: string };
      if (res.ok && !("error" in data)) setSummary(data);
    } catch {
      // best-effort; the panel surfaces its own action errors
    }
  }

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
                ? {
                    ...q,
                    hit,
                    foundRank,
                    storedSim: null,
                    stale: false,
                    scoredAt: Date.now(),
                  }
                : q,
            ),
          },
    );
  }

  // Drive a process/rescore run from its NDJSON event stream: advance the
  // progress bar, patch question badges live, and reconcile via reload() at the end.
  async function runStream(
    url: string,
    label: (r: RunResult) => string,
    body?: unknown,
  ) {
    setBusy(true);
    setNotice(null);
    setError(null);
    setProgress(null);
    try {
      const res = await apiFetch(
        url,
        body === undefined
          ? { method: "POST" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
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
              setProgress({
                phase: "generate",
                done: event.done,
                total: event.total,
              });
              break;
            case "score-start":
              hits = 0;
              setProgress({
                phase: "score",
                done: 0,
                total: event.total,
                hits: 0,
              });
              break;
            case "score-result":
              if (event.hit) hits += 1;
              setProgress({
                phase: "score",
                done: event.done,
                total: event.total,
                hits,
              });
              patchQuestion(event.questionId, event.hit, event.foundRank);
              break;
            case "done":
              final = {
                generated: event.generated,
                scored: event.scored,
                recall: event.recall,
                mrr: event.mrr,
                ndcg: event.ndcg,
              };
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
        `Generated ${r.generated} question(s), scored ${r.scored}. ` +
        `Recall@k ${pct(r.recall)} · nDCG ${fmtScore(r.ndcg)}.`,
    );

  const onRescore = (documentId: string | null) =>
    runStream(
      "/api/eval/rescore",
      (r) =>
        `Re-scored ${r.scored} question(s). ` +
        `Recall@k ${pct(r.recall)} · nDCG ${fmtScore(r.ndcg)}.`,
      documentId ? { documentId } : undefined,
    );

  // Bulk actions → Add question → {difficulty}: generate at one difficulty
  // (corpus-wide, or one document when scoped), then score. Same NDJSON stream.
  const onBulkAdd = (difficulty: Difficulty, documentId: string | null) =>
    runStream(
      "/api/eval/bulk-generate",
      (r) =>
        `Added ${r.generated} ${difficulty} question(s), scored ${r.scored}. ` +
        `Recall@k ${pct(r.recall)} · nDCG ${fmtScore(r.ndcg)}.`,
      { difficulty, documentId: documentId ?? undefined },
    );

  async function saveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/eval/questions/${id}`, {
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
      const res = await apiFetch(`/api/eval/questions/${id}`, {
        method: "DELETE",
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

  // "Ignore in rates" (§7): config-scoped, reversible; ignoring warns first
  // because it removes the question from Recall/nDCG rates + autotune targeting.
  async function toggleIgnore(q: QuestionDetail) {
    if (
      !q.ignored &&
      !window.confirm(
        "Ignore this question in rates?\n\nManually verify it is genuinely a " +
          "distractor artifact (e.g. answerable from other legitimate chunks) " +
          "before ignoring — this removes it from your Recall/nDCG rates and " +
          "from autotune targeting. You can un-ignore it any time.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/eval/questions/${q.questionId}/ignore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ignored: !q.ignored }),
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

  // Add a hand-written question to a chunk. It lands unscored; the next "Process
  // new chunks" / "Re-score all" scores it like any other.
  async function addQuestion(chunkId: string) {
    const text = addText.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/eval/questions", {
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

  // Author one synthetic question for a chunk at the chosen difficulty. Like a
  // manual add it lands unscored; the next run scores it. The LLM call runs
  // server-side, so this can take a moment — the clicked button shows progress.
  async function generateQuestion(chunkId: string, difficulty: Difficulty) {
    setBusy(true);
    setError(null);
    setGenDifficulty(difficulty);
    try {
      const res = await apiFetch("/api/eval/questions/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkId, difficulty }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      reload();
    } finally {
      setBusy(false);
      setGenDifficulty(null);
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
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onProcess}
          disabled={busy || !canProcess}
          title={
            canProcess
              ? "Generate the selected difficulties for new chunks and score anything unscored"
              : "Nothing pending — pick a difficulty in Bulk actions, or there are no unscored questions"
          }
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Processing…" : "Process new chunks"}
        </button>
        <BulkActions
          busy={busy}
          onAddDifficulty={onBulkAdd}
          onChangeConfig={(docId, docName) =>
            setChangeScope({ docId, docName })
          }
          onRescore={onRescore}
          canRescore={canRescore}
          canAddQuestion={summary === null || summary.chunkCount > 0}
        />
        {summary && (
          <AutotunePanel
            summary={summary}
            busy={busy}
            onBusyChange={setBusy}
            onDone={reload}
          />
        )}
        {!progress && notice && (
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {notice}
          </span>
        )}
      </div>

      {changeScope && summary && (
        <ConfigChangeDialog
          config={summary.config}
          documentId={changeScope.docId}
          documentName={changeScope.docName}
          onClose={() => setChangeScope(null)}
          onDone={() => {
            // Settings/labels changed — refresh the banner and re-pull the summary.
            router.refresh();
            reload();
          }}
        />
      )}

      {progress && <RunProgress progress={progress} k={summary?.k ?? 0} />}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {summary === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Headline metrics — one labeled card per eval */}
          <div className="flex flex-wrap gap-4">
            {summary.criteria.recall.enabled && (
              <Stat
                label={`Recall@${summary.recallK}`}
                value={pct(summary.recall)}
                big
                sub={
                  summary.criteria.recall.minRate != null
                    ? `min ${pct(summary.criteria.recall.minRate)}`
                    : undefined
                }
              />
            )}
            {summary.criteria.ndcg.enabled && (
              <Stat
                label={`nDCG@${summary.ndcgK}`}
                value={fmtScore(summary.ndcg)}
                big
                sub={
                  `${summary.ndcgCovered}/${summary.total} graded` +
                  (summary.criteria.ndcg.minRate != null
                    ? ` · min ${summary.criteria.ndcg.minRate.toFixed(2)}`
                    : "")
                }
              />
            )}
            <Stat label="Questions" value={String(summary.total)} />
            <Stat label="Scored" value={String(summary.scored)} />
            <Stat label="Hits" value={String(summary.hits)} />
          </div>

          {summary.total === 0 && (
            <p className="text-sm text-zinc-500">
              No eval questions yet. Ingest a document, then click “Process new
              chunks”.
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
                      {d.hits}/{d.scored} ·{" "}
                      {pct(d.scored > 0 ? d.hits / d.scored : null)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Run history — collapsible; grows over time so it folds away by default. */}
          {summary.runs.length > 0 && (
            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setRunsOpen((o) => !o)}
                className="flex cursor-pointer items-center gap-2 self-start text-sm font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                <span className="text-zinc-400">{runsOpen ? "▾" : "▸"}</span>
                Runs
                <span className="text-xs font-normal normal-case tracking-normal text-zinc-400">
                  ({summary.runs.length})
                </span>
              </button>
              {runsOpen && (
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
                        {pct(
                          r.questionCount > 0
                            ? r.hitCount / r.questionCount
                            : null,
                        )}
                        <span className="ml-2 text-xs font-normal text-zinc-500">
                          nDCG {fmtScore(r.ndcg)} · ({r.hitCount}/
                          {r.questionCount} @ k=
                          {r.k})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
                    (q) => q.hit !== null && !q.stale && !q.ignored,
                  );
                  const hits = scored.filter((q) => q.hit === true).length;
                  // Mean stored sim of the ground-truth chunk across this chunk's
                  // scored questions — same read as a trial's "avg sim", but for
                  // the live (baseline/delegate) retrieval.
                  const sims = scored
                    .map((q) => q.storedSim)
                    .filter((s): s is number => s !== null);
                  const avgSim =
                    sims.length > 0
                      ? sims.reduce((sum, s) => sum + s, 0) / sims.length
                      : null;
                  const override = summary.overrides.find(
                    (o) => o.chunkId === group.chunkId,
                  );
                  // A model-kind override = this chunk's DELEGATE model: retrieval
                  // ranks it there instead of the config's base model.
                  const delegateModel =
                    override && override.kind !== "size"
                      ? override.model
                      : null;
                  return (
                    <div
                      key={group.chunkId}
                      className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
                    >
                      {/* Which chunk these questions belong to */}
                      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {override && <OverrideBadge info={override} />}
                          <span className="truncate">
                            {group.fileName} · chunk #{group.position ?? "?"}
                          </span>
                          {delegateModel && (
                            <span
                              title="Delegate model: this chunk is embedded and ranked under this model (not the config's base model). Its questions count toward config metrics under it after a re-score."
                              className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                            >
                              {delegateModel}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {scored.length > 0
                            ? `${hits}/${scored.length} hit${scored.length === 1 ? "" : "s"}`
                            : "unscored"}
                          {avgSim !== null && (
                            <span className="text-zinc-400">
                              {" "}
                              · avg sim {avgSim.toFixed(3)}
                            </span>
                          )}
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
                                <span
                                  className={
                                    q.ignored
                                      ? "flex-1 text-zinc-400"
                                      : "flex-1"
                                  }
                                >
                                  {q.question}
                                </span>
                              )}
                              <span className="flex shrink-0 items-center gap-1.5">
                                {q.ignored && (
                                  <span
                                    title="Ignored in rates — excluded from Recall/nDCG and autotune targeting"
                                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                                  >
                                    ignored
                                  </span>
                                )}
                                {!q.ignored &&
                                  q.hit === false &&
                                  q.ndcg !== null &&
                                  q.ndcg >= HIGH_NDCG && (
                                    <span
                                      title={
                                        "Possible false positive: nDCG is high but recall missed — the ground-truth chunk ranks well against its ideal but was crowded out of the top-k by other relevant chunks. Verify, then consider 'Ignore'."
                                      }
                                      className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                                    >
                                      FP?
                                    </span>
                                  )}
                                <Badge
                                  hit={q.hit}
                                  rank={q.foundRank}
                                  stale={q.stale}
                                />
                                <MetricChip label="nDCG" value={q.ndcg} />
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3 text-xs text-zinc-500">
                              <span className="flex items-center gap-1.5 font-mono text-zinc-400">
                                {q.source === "manual" && <span>manual</span>}
                                {q.difficulty && (
                                  <span
                                    className={
                                      q.difficulty === "hard"
                                        ? "rounded px-1 capitalize bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
                                        : q.difficulty === "medium"
                                          ? "rounded px-1 capitalize bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                                          : "rounded px-1 capitalize bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                                    }
                                  >
                                    {q.difficulty}
                                  </span>
                                )}
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
                                        onClick={() =>
                                          toggleExpand(q.questionId)
                                        }
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
                                      type="button"
                                      onClick={() =>
                                        setRankingOpenId((id) =>
                                          id === q.questionId
                                            ? null
                                            : q.questionId,
                                        )
                                      }
                                      title={
                                        rankingOpenId === q.questionId
                                          ? "Hide the nDCG ranking builder"
                                          : "Build the graded ideal ranking this question's nDCG scores against"
                                      }
                                      className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                                    >
                                      nDCG
                                    </button>
                                    {(q.ignored ||
                                      failsBar(q, summary.criteria)) && (
                                      <button
                                        onClick={() => toggleIgnore(q)}
                                        disabled={busy}
                                        title={
                                          q.ignored
                                            ? "Count this question in rates again"
                                            : "Exclude this question from rates and autotune targeting (manual false-positive mode)"
                                        }
                                        className="cursor-pointer hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        {q.ignored ? "Unignore" : "Ignore"}
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
                                chunkId={q.sourceChunkId}
                                state={explains[q.questionId]}
                                k={summary.k}
                              />
                            )}
                            {rankingOpenId === q.questionId && (
                              <NdcgRankingPanel
                                questionId={q.questionId}
                                onChange={refreshSummary}
                              />
                            )}
                          </li>
                        ))}
                      </ul>

                      {/* Saved "Models tried" (above), add-question form, then the
                          ephemeral "Try a different model" runner. */}
                      <ChunkExperiments
                        chunkId={group.chunkId}
                        baselineModel={summary.config.baseModel}
                        overrideInfo={override ?? null}
                        onDelegateChange={reload}
                      >
                        {/* Add a question — synthetic (LLM, graded) or hand-written */}
                        <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
                          {addingChunkId === group.chunkId ? (
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex gap-2 text-xs">
                                  <ModeTab
                                    active={addMode === "synthetic"}
                                    onClick={() => setAddMode("synthetic")}
                                  >
                                    Synthetic
                                  </ModeTab>
                                  <ModeTab
                                    active={addMode === "manual"}
                                    onClick={() => setAddMode("manual")}
                                  >
                                    Manual
                                  </ModeTab>
                                </div>
                                <button
                                  onClick={() => setAddingChunkId(null)}
                                  className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                                >
                                  ✕
                                </button>
                              </div>

                              {addMode === "synthetic" ? (
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                  <span className="text-zinc-500">
                                    Generate one question at:
                                  </span>
                                  {(["easy", "medium", "hard"] as const).map(
                                    (d) => (
                                      <button
                                        key={d}
                                        onClick={() =>
                                          generateQuestion(group.chunkId, d)
                                        }
                                        disabled={busy}
                                        className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 font-medium capitalize text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                      >
                                        {genDifficulty === d
                                          ? "Generating…"
                                          : d}
                                      </button>
                                    ),
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <input
                                    value={addText}
                                    onChange={(e) => setAddText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter")
                                        addQuestion(group.chunkId);
                                      if (e.key === "Escape")
                                        setAddingChunkId(null);
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
                                </div>
                              )}
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
                      </ChunkExperiments>
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

// One hover row for the yellow-◷ tooltip, in the plan's §6.4 shape:
// "easy · recall miss #14 → hit #3", "hard · nDCG 0.41 → 0.78".
function fmtOutcome(o: OverrideOutcome): string {
  const d = o.difficulty ?? "·";
  if (o.metric === "recall") {
    const side = (v: number | null, rank: number | null) =>
      v === null
        ? "—"
        : v >= 1
          ? `hit #${rank ?? "?"}`
          : `miss${rank ? ` #${rank}` : ""}`;
    return `${d} · recall ${side(o.beforeValue, o.beforeRank)} → ${side(o.afterValue, o.afterRank)}`;
  }
  const val = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  return `${d} · nDCG ${val(o.beforeValue)} → ${val(o.afterValue)}`;
}

// Chunk-header badges for an active per-chunk override (Phase D, §6.4): yellow
// ◷ = this chunk was re-shaped/re-modeled (hover shows the override and each
// question's before → after from the autotune run); red ❗ = its pieces don't
// cover the source chunk's full token span (part of the document dropped out of
// retrieval — guards custom-boundary overrides).
function OverrideBadge({ info }: { info: ChunkOverrideInfo }) {
  const what =
    info.kind === "model"
      ? `re-embedded under ${info.model}`
      : info.kind === "size"
        ? `re-split into ${info.pieceCount} piece(s)`
        : `re-split into ${info.pieceCount} piece(s) under ${info.model}`;
  return (
    <>
      <span className="group relative shrink-0 cursor-default">
        <span className="text-amber-500 dark:text-amber-400">◷</span>
        <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-xs flex-col gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-left font-sans text-xs normal-case text-zinc-700 shadow-lg group-hover:flex dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <span className="font-medium">Override: {what}</span>
          {info.outcomes.length > 0 ? (
            info.outcomes.map((o, i) => (
              <span
                key={i}
                title={o.question}
                className="font-mono text-zinc-500"
              >
                {fmtOutcome(o)}
              </span>
            ))
          ) : (
            <span className="text-zinc-400">
              Applied manually (no autotune outcome recorded).
            </span>
          )}
        </span>
      </span>
      {info.hasGap && (
        <span
          title="Coverage gap: this chunk's override pieces don't span its full text — part of the document is missing from retrieval."
          className="shrink-0 text-red-600 dark:text-red-400"
        >
          ❗
        </span>
      )}
    </>
  );
}

// Bulk actions: "add question at difficulty", "re-score all", and the "change
// base model / chunk size" entries that edit THIS config in place. The scope
// dropdown at the top targets everything at the whole corpus ("All documents",
// the default) or one document — doc-scoped config changes apply as per-chunk
// overrides.
function BulkActions({
  busy,
  onAddDifficulty,
  onChangeConfig,
  onRescore,
  canRescore,
  canAddQuestion,
}: {
  busy: boolean;
  onAddDifficulty: (d: Difficulty, documentId: string | null) => void;
  onChangeConfig: (
    documentId: string | null,
    documentName: string | null,
  ) => void;
  onRescore: (documentId: string | null) => void;
  canRescore: boolean;
  canAddQuestion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  // Document scope. "" = all documents. The list is fetched once, on first open.
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [docId, setDocId] = useState("");
  const close = () => {
    setOpen(false);
    setSubOpen(false);
  };

  function toggleMenu() {
    const opening = !open;
    setOpen(opening);
    if (!opening || docs !== null) return;
    apiFetch("/api/documents")
      .then((res) => res.json())
      .then((data: { documents?: IngestedDocument[] }) =>
        setDocs(data.documents ?? []),
      )
      .catch(() => setDocs([]));
  }

  const scopeId = docId || null;
  const scopeName = scopeId
    ? (docs?.find((d) => d.id === scopeId)?.fileName ?? null)
    : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleMenu}
        disabled={busy}
        title="Bulk changes across the whole corpus, or one document via the scope picker"
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Bulk actions ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute left-0 top-full z-20 mt-1 w-60 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            {/* Which documents the actions below apply to. */}
            <label className="flex flex-col gap-1 px-3 pb-1.5 pt-1 text-xs text-zinc-500">
              Apply to
              <select
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
                className="w-full rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">All documents</option>
                {docs?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
            <button
              type="button"
              onClick={() => setSubOpen((s) => !s)}
              disabled={!canAddQuestion}
              title={
                canAddQuestion
                  ? undefined
                  : "No chunks yet — ingest a document first"
              }
              className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Add question{" "}
              <span className="text-zinc-400">{subOpen ? "▾" : "▸"}</span>
            </button>
            {subOpen && (
              <div className="flex gap-1 px-3 pb-1.5 pt-0.5">
                {(["easy", "medium", "hard"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      close();
                      onAddDifficulty(d, scopeId);
                    }}
                    className="cursor-pointer rounded border border-zinc-300 px-2 py-0.5 text-xs font-medium capitalize text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                close();
                onRescore(scopeId);
              }}
              disabled={!canRescore}
              title={
                canRescore
                  ? "Re-run retrieval scoring for every labeled question in scope"
                  : "No labeled questions to re-score yet"
              }
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Re-score all
            </button>
            <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
            <button
              type="button"
              onClick={() => {
                close();
                onChangeConfig(scopeId, scopeName);
              }}
              title={
                scopeId
                  ? "Overrides this document's chunks to another model (config unchanged)"
                  : "Changes THIS config in place — re-embeds but keeps question(s)"
              }
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Change base model…
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                onChangeConfig(scopeId, scopeName);
              }}
              title={
                scopeId
                  ? "Re-splits this document's chunks via per-chunk overrides (config unchanged)"
                  : "Changes THIS config in place — re-embeds but keeps question(s)"
              }
              className="block w-full cursor-pointer px-3 py-1.5 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Adjust chunk size / overlap…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// A plain bordered headline card. `sub` is an optional small line under the
// value — e.g. the nDCG card's "graded" coverage count. (Metric cards are no
// longer tinted; the per-question MetricChip still carries the red→green tint.)
function Stat({
  label,
  value,
  big,
  sub,
}: {
  label: string;
  value: string;
  big?: boolean;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className={big ? "text-2xl font-semibold" : "text-lg font-medium"}>
        {value}
      </span>
      {sub && <span className="text-xs text-zinc-400">{sub}</span>}
    </div>
  );
}

// A per-question metric value next to the hit/miss badge, labeled so it's clear
// which eval it belongs to. null = not graded (unscored, or stale so the old
// score no longer applies) — rendered as the grey-dash placeholder.
function MetricChip({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
        {label} –
      </span>
    );
  }
  return (
    <span
      style={scoreTint(value)}
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${tintBgClass} ${tintTextClass}`}
    >
      {label} {value.toFixed(2)}
    </span>
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
  chunkId,
  state,
  k,
}: {
  questionId: string;
  chunkId: string;
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
    return (
      <p className="mt-1 text-xs text-red-600 dark:text-red-400">
        {state.message}
      </p>
    );
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
            Expected ·{" "}
            <span className="font-mono normal-case">
              {expected?.fileName ?? "?"}
            </span>{" "}
            · chunk #{expected?.position ?? "?"}
            {scored && ` · not in top ${k}`}
            {expected?.rank != null && (
              <span className="text-zinc-400"> · rank #{expected.rank}</span>
            )}
            {expected?.score != null && (
              <span className="text-zinc-400">
                {" "}
                · sim {expected.score.toFixed(3)}
              </span>
            )}
          </span>
          <ChunkText
            text={expected?.text ?? "Chunk text unavailable."}
            expected
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          Retrieved · top {k}
        </span>
        {!scored ? (
          <span className="text-zinc-400">
            Not scored yet — no retrieval recorded.
          </span>
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
            Between ·{" "}
            {gapLo === gapHi ? `rank ${gapLo}` : `ranks ${gapLo}–${gapHi}`}
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

      {/* What-if: re-chunk this one chunk and re-rank (ephemeral until "Set as
          size override"). */}
      <RechunkExperiment
        questionId={questionId}
        chunkId={chunkId}
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
  chunkId,
  baseline,
  k,
  positionHint,
}: {
  questionId: string;
  chunkId: string;
  baseline: { rank: number | null; score: number | null } | null;
  k: number;
  positionHint: number;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"uniform" | "custom">("uniform");
  // Both tabs stay mounted (just hidden) once visited, so switching between them
  // preserves each one's inputs/results. Closing with ✕ resets everything. The
  // custom tab is lazy-mounted so its window fetch only fires once it's opened.
  const [mounted, setMounted] = useState({ uniform: true, custom: false });

  function show(next: "uniform" | "custom") {
    setMode(next);
    setMounted((m) => (m[next] ? m : { ...m, [next]: true }));
  }

  function close() {
    setOpen(false);
    setMode("uniform");
    setMounted({ uniform: true, custom: false });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer self-start rounded border border-dashed border-zinc-300 px-2 py-1 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900/40"
      >
        Re-chunk this chunk
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-2 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <ModeTab active={mode === "uniform"} onClick={() => show("uniform")}>
            Uniform sub-divide
          </ModeTab>
          <ModeTab active={mode === "custom"} onClick={() => show("custom")}>
            Resize borders
          </ModeTab>
        </div>
        <button
          type="button"
          onClick={close}
          className="cursor-pointer text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          ✕
        </button>
      </div>

      <div className={mode === "uniform" ? "" : "hidden"}>
        {mounted.uniform && (
          <RechunkLab
            questionId={questionId}
            chunkId={chunkId}
            baseline={baseline}
            k={k}
          />
        )}
      </div>
      <div className={mode === "custom" ? "" : "hidden"}>
        {mounted.custom && (
          <ChunkBoundaryLab
            questionId={questionId}
            baseline={baseline}
            k={k}
            positionHint={positionHint}
          />
        )}
      </div>
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
      className={`cursor-pointer rounded border px-2 py-1 font-medium ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
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
        <span className="font-medium uppercase tracking-wide text-zinc-500">
          Pieces
        </span>
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
                  piece {s.subIndex + 1}/{result.subChunkCount} · rank #{s.rank}{" "}
                  · sim {s.score.toFixed(3)}
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
                  <span className="text-zinc-400">{open[id] ? "▾" : "▸"}</span>#
                  {c.rank} · <span className="font-mono">{label}</span> · sim{" "}
                  {c.score.toFixed(3)}
                  {c.isSubChunk && " · this chunk ✓"}
                </button>
                {open[id] && (
                  <ChunkText text={c.text} expected={c.isSubChunk} />
                )}
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
  chunkId,
  baseline,
  k,
}: {
  questionId: string;
  chunkId: string;
  baseline: { rank: number | null; score: number | null } | null;
  k: number;
}) {
  const [size, setSize] = useState(256);
  const [overlap, setOverlap] = useState(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RechunkResult | null>(null);
  // Persisting this trial as a size override (Phase B). `saved` ties to the
  // (size, overlap) that produced the current result; a fresh Run clears it.
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const invalid =
    !Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size;

  async function run() {
    if (invalid) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    setSaveErr(null);
    try {
      const res = await apiFetch(`/api/eval/questions/${questionId}/rechunk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, overlap }),
      });
      const data = (await res.json()) as RechunkResult | { error: string };
      if (!res.ok || "error" in data) {
        setError(
          "error" in data ? data.error : `Request failed (${res.status}).`,
        );
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

  // Persist this (size, overlap) as a size override for the chunk: retrieval then
  // represents it by its best piece. Takes effect on the next Re-score.
  async function saveOverride() {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, overlap }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setSaveErr(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSaving(false);
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
        <>
          <RechunkResultView
            result={result}
            baseline={baseline}
            k={k}
            annotation={`${result.subChunkCount} piece${result.subChunkCount === 1 ? "" : "s"} @ size ${size} / overlap ${overlap}`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveOverride}
              disabled={saving || saved}
              title="Persist this re-split as a size override for this chunk (RRF-fused; hit = any piece in top-k)"
              className="cursor-pointer rounded border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900/40"
            >
              {saving ? "Saving…" : saved ? "Saved ✓" : "Set as size override"}
            </button>
            {saved && (
              <span className="text-zinc-500">
                Re-score to apply across this chunk’s questions.
              </span>
            )}
            {saveErr && (
              <span className="text-red-600 dark:text-red-400">{saveErr}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Selection reported by the border picker: the reshaped chunk's text plus the
// stats callers need for annotations and warnings.
type BorderSelection = {
  text: string;
  tokens: number;
  gapTokens: number;
  intoNeighbors: number;
};

// Mode B — resize one custom chunk: pick borders (drag or numeric), then re-rank
// the question against the corpus with that one reshaped chunk substituted in.
// Ephemeral; the picker itself is shared with "try a different configuration".
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
  const [sel, setSel] = useState<BorderSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RechunkResult | null>(null);

  async function run() {
    if (!sel) return;
    setBusy(true);
    setRunError(null);
    try {
      const res = await apiFetch(`/api/eval/questions/${questionId}/rechunk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: [sel.text] }),
      });
      const data = (await res.json()) as RechunkResult | { error: string };
      if (!res.ok || "error" in data) {
        setRunError(
          "error" in data ? data.error : `Request failed (${res.status}).`,
        );
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

  return (
    <div className="flex flex-col gap-2">
      <ChunkBorderPicker
        questionId={questionId}
        positionHint={positionHint}
        onSelection={setSel}
      >
        <button
          onClick={run}
          disabled={busy || !sel}
          className="rounded-md bg-black px-3 py-1.5 font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </ChunkBorderPicker>

      {runError && (
        <span className="text-red-600 dark:text-red-400">{runError}</span>
      )}

      {result && sel && (
        <RechunkResultView
          result={result}
          baseline={baseline}
          k={k}
          annotation={`custom · ${sel.tokens} tokens${sel.gapTokens > 0 ? `, ${sel.gapTokens} uncovered` : ""}`}
        />
      )}
    </div>
  );
}

// The draggable-border picker (extracted from the boundary lab so the
// "try a different configuration" runner reuses it). Stitches the labeled chunk
// + frozen neighbors into contiguous text, lets the user set the chunk's
// [start, end) token borders (numeric inputs, or by dragging the borders in the
// preview — each drag snaps to the nearest token), warns when the borders leave
// document text uncovered (a gap), and reports the selection upward. `children`
// renders in the inputs row — the caller's action button(s). Read-only.
function ChunkBorderPicker({
  questionId,
  positionHint,
  onSelection,
  children,
}: {
  questionId: string;
  positionHint: number;
  onSelection: (sel: BorderSelection | null) => void;
  children?: ReactNode;
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

  // Which border the user is currently dragging in the text preview, if any.
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  // (Re)fetch the window when the range changes. Widening shifts token indices,
  // so the selection resets to the chunk's own span on each load. Keeping the
  // prior window visible during a refetch avoids a flash back to "Loading…".
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await apiFetch(
          `/api/eval/questions/${questionId}/window?from=${range.from}&to=${range.to}`,
        );
        const data = (await res.json()) as ChunkWindow | { error: string };
        if (!alive) return;
        if (!res.ok || "error" in data) {
          setWinError(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
          return;
        }
        setWinError(null);
        setWin(data);
        setStart(data.testDefault.tokenStart);
        setEnd(data.testDefault.tokenEnd);
      } catch (err) {
        if (alive)
          setWinError(
            err instanceof Error ? err.message : "Failed to load window.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [questionId, range.from, range.to]);

  // While a border is being dragged, follow the pointer: map its position to a
  // character with the caret APIs, snap to the nearest token boundary, and move
  // that border there. Listening on `window` keeps the drag alive even when the
  // pointer leaves the text box.
  useEffect(() => {
    if (!dragging || !win) return;
    const { offsets, tokenCount } = win;

    // Nearest token boundary to a char index (offsets is ascending).
    const charToToken = (charIdx: number) => {
      let lo = 0;
      let hi = tokenCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] < charIdx) lo = mid + 1;
        else hi = mid;
      }
      if (
        lo > 0 &&
        Math.abs(offsets[lo - 1] - charIdx) <= Math.abs(offsets[lo] - charIdx)
      ) {
        return lo - 1;
      }
      return lo;
    };

    // Pointer → token, via whichever caret API the browser exposes. Returns null
    // when the hit lands off the painted text (e.g. on the handle itself).
    const pointToToken = (x: number, y: number): number | null => {
      const doc = document as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      let node: Node | null = null;
      let offset = 0;
      if (doc.caretPositionFromPoint) {
        const pos = doc.caretPositionFromPoint(x, y);
        if (!pos) return null;
        node = pos.offsetNode;
        offset = pos.offset;
      } else if (doc.caretRangeFromPoint) {
        const r = doc.caretRangeFromPoint(x, y);
        if (!r) return null;
        node = r.startContainer;
        offset = r.startOffset;
      } else {
        return null;
      }
      const host =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as Element);
      const span = host?.closest<HTMLElement>("[data-cs]");
      if (!span) return null;
      const base = Number(span.dataset.cs);
      if (Number.isNaN(base)) return null;
      return charToToken(base + offset);
    };

    const onMove = (e: PointerEvent) => {
      const tok = pointToToken(e.clientX, e.clientY);
      if (tok == null) return;
      if (dragging === "start") setStart(tok);
      else setEnd(tok);
    };
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, win]);

  // Report the current selection upward whenever it changes (or turns invalid).
  useEffect(() => {
    if (!win) {
      onSelection(null);
      return;
    }
    const { offsets, tokenCount, exclusive, text } = win;
    const s = Math.max(0, Math.min(start, tokenCount));
    const e = Math.max(0, Math.min(end, tokenCount));
    if (s >= e) {
      onSelection(null);
      return;
    }
    const exLen = Math.max(0, exclusive.tokenEnd - exclusive.tokenStart);
    const exCovered = Math.max(
      0,
      Math.min(e, exclusive.tokenEnd) - Math.max(s, exclusive.tokenStart),
    );
    const intoNeighbors =
      Math.max(0, exclusive.tokenStart - s) +
      Math.max(0, e - exclusive.tokenEnd);
    onSelection({
      text: text.slice(offsets[s], offsets[e]),
      tokens: e - s,
      gapTokens: exLen - exCovered,
      intoNeighbors,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on selection change only
  }, [win, start, end]);

  if (loading && !win)
    return <span className="text-zinc-400">Loading window…</span>;
  if (winError)
    return <span className="text-red-600 dark:text-red-400">{winError}</span>;
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
    Math.min(clampedEnd, exclusive.tokenEnd) -
      Math.max(clampedStart, exclusive.tokenStart),
  );
  const gapTokens = exLen - exCovered;
  const intoNeighbors =
    Math.max(0, exclusive.tokenStart - clampedStart) +
    Math.max(0, clampedEnd - exclusive.tokenEnd);

  // Char offsets of the selection and the exclusive zone — the breakpoints used
  // to paint the preview and to anchor the draggable borders.
  const sStart = off(clampedStart);
  const sEnd = off(clampedEnd);
  const exStartChar = off(exclusive.tokenStart);
  const exEndChar = off(exclusive.tokenEnd);

  const selClass =
    "bg-indigo-200/70 text-zinc-900 dark:bg-indigo-500/30 dark:text-zinc-100";
  const gapClass =
    "bg-red-200/70 text-zinc-900 dark:bg-red-500/30 dark:text-zinc-100";
  const ctxClass = "text-zinc-400";

  // Paint a [from, to) char range as frozen-neighbor (ctx) or uncovered
  // exclusive-zone (gap) bands. Each span carries its absolute char start
  // (data-cs) so a drag can map a caret hit back to a token. The selected text
  // is rendered separately, between the handles, so it never appears here.
  const bands = (from: number, to: number) => {
    const cuts = Array.from(new Set([from, to, exStartChar, exEndChar]))
      .filter((c) => c >= from && c <= to)
      .sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b <= a) continue;
      const inExclusive = a >= exStartChar && b <= exEndChar;
      out.push(
        <span key={a} data-cs={a} className={inExclusive ? gapClass : ctxClass}>
          {text.slice(a, b)}
        </span>,
      );
    }
    return out;
  };

  // A draggable border on the selected chunk. Dragging snaps to the nearest
  // token (see the drag effect above); arrow keys nudge by one token (10 with
  // Shift) for precise/keyboard adjustment.
  const handle = (side: "start" | "end") => {
    const value = side === "start" ? clampedStart : clampedEnd;
    const set = side === "start" ? setStart : setEnd;
    return (
      <span
        role="slider"
        tabIndex={0}
        aria-label={`Drag ${side} border`}
        aria-valuemin={0}
        aria-valuemax={tokenCount}
        aria-valuenow={value}
        title="Drag to resize — snaps to the nearest token"
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(side);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            set(Math.max(0, value - step));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            set(Math.min(tokenCount, value + step));
          }
        }}
        className={`relative mx-px inline-block h-[1.15em] w-1 cursor-col-resize touch-none rounded-sm bg-indigo-500 align-text-bottom after:absolute after:inset-y-0 after:-inset-x-1 after:content-[''] hover:bg-indigo-600 dark:bg-indigo-400 ${
          dragging === side ? "ring-2 ring-indigo-400" : ""
        }`}
      />
    );
  };

  const canLoadMore = win.rangeFrom > 0 || win.rangeTo < win.totalChunks - 1;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-zinc-500">
        chunk #{win.testPosition} of {win.totalChunks} · viewing window #
        {win.rangeFrom}–#{win.rangeTo} · {tokenCount} tokens. Neighbors are
        frozen; this chunk’s exclusive zone is tokens {exclusive.tokenStart}–
        {exclusive.tokenEnd}.
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
        {children}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-400">
          {validSel
            ? `${clampedEnd - clampedStart} tokens selected`
            : "start must be below end"}
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

      <pre
        className={`max-h-56 overflow-auto whitespace-pre-wrap rounded border border-zinc-200 bg-zinc-50 p-2 font-mono leading-relaxed dark:border-zinc-800 dark:bg-zinc-900/40 ${
          dragging ? "cursor-col-resize select-none" : ""
        }`}
      >
        {validSel ? (
          <>
            {bands(0, sStart)}
            {handle("start")}
            <span data-cs={sStart} className={selClass}>
              {text.slice(sStart, sEnd)}
            </span>
            {handle("end")}
            {bands(sEnd, text.length)}
          </>
        ) : (
          bands(0, text.length)
        )}
      </pre>

      <div className="flex items-center gap-3 text-zinc-500">
        <span>
          <span className="rounded bg-indigo-200/70 px-1 dark:bg-indigo-500/30">
            selected
          </span>{" "}
          <span className="rounded bg-red-200/70 px-1 dark:bg-red-500/30">
            gap
          </span>{" "}
          <span className="text-zinc-400">frozen neighbor</span>
        </span>
        <span className="text-zinc-400">
          Drag the indigo borders to resize (snaps to tokens).
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
        <span className="text-zinc-400">{isOpen ? "▾" : "▸"}</span>#{chunk.rank}{" "}
        · <span className="font-mono">{chunk.fileName ?? "?"}</span> · chunk #
        {chunk.position ?? "?"}
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
  const recall =
    scoring && progress.done > 0 ? progress.hits / progress.done : null;

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

// ---------------------------------------------------------------------------
// Per-chunk "try a different configuration" experiment. Re-ranks this chunk's
// questions against a small candidate pool — the chunk (always in) + its
// questions' top-k + any corpus chunks you add — under a VARIATION: an alternate
// model, a re-shaped chunk (uniform re-split or dragged borders), or both
// (combination). Ephemeral by default; "Save result" persists a snapshot
// rendered under the chunk's variations lists. Each question's pool rank is
// shown against its stored full-corpus result.
// ---------------------------------------------------------------------------
type TrialState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; ctx: ModelTrialContext };

// Which knob(s) the trial turns. "combo" = model + chunk shape together.
type VariationChoice = "model" | "size" | "combo";

// Human label for a trial's shape variation, e.g. "re-split 256/25 tokens · 3
// pieces" or "custom borders · 1 piece". Model-only trials need no shape label.
function variationLabel(
  kind: TrialKind,
  chunkSize: number | null,
  chunkOverlap: number | null,
  pieceCount: number | null,
): string | undefined {
  if (kind === "model") return undefined;
  const shape =
    chunkSize != null
      ? `${chunkSize}/${chunkOverlap ?? 0} tokens`
      : "custom borders";
  const pieces =
    pieceCount != null
      ? ` · ${pieceCount} piece${pieceCount === 1 ? "" : "s"}`
      : "";
  return `re-split ${shape}${pieces}`;
}

// A selectable variation option: colored when active, with a small checkmark —
// deliberately not a checkbox.
function VariationPill({
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
      className={`cursor-pointer rounded-full border px-2.5 py-0.5 font-medium transition-colors ${
        active
          ? "border-indigo-400 bg-indigo-100 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
          : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }`}
    >
      {active && <span className="mr-1">✓</span>}
      {children}
    </button>
  );
}

function ModelTrial({
  chunkId,
  onSaved,
}: {
  chunkId: string;
  onSaved: (trial: SavedModelTrial) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TrialState | null>(null);

  const [variation, setVariation] = useState<VariationChoice>("model");
  const [model, setModel] = useState("");
  // Chunk-shape knobs (size / combo): uniform re-split inputs, or the custom
  // drag-border selection from the shared picker.
  const [shapeMode, setShapeMode] = useState<"uniform" | "custom">("uniform");
  const [size, setSize] = useState(256);
  const [overlap, setOverlap] = useState(25);
  const [customSel, setCustomSel] = useState<BorderSelection | null>(null);
  // Pool chunk ids the user has ticked (the chunk itself is always included
  // server-side). Seeded with the auto pool — the questions' top-k — on load.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showCorpus, setShowCorpus] = useState(false);

  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<ModelTrialResult | null>(null);
  // Whether the currently-shown result has been persisted — keeps "Save result"
  // disabled so the same snapshot can't be saved twice. A fresh Run clears it.
  const [savedResult, setSavedResult] = useState(false);
  // Phase 5: this chunk's persisted model override for the active config (null =
  // none). Setting it re-embeds the chunk under that model so retrieval ranks it
  // there (RRF-fused). Re-score to see the effect on recall.
  const [override, setOverride] = useState<string | null>(null);
  const [ovBusy, setOvBusy] = useState(false);

  // Lazy-load the trial context the first time the panel opens.
  function toggleOpen() {
    const opening = !open;
    setOpen(opening);
    if (!opening || state) return;
    setState({ status: "loading" });
    apiFetch(`/api/eval/chunks/${chunkId}/try-model`)
      .then(async (res) => {
        const data = (await res.json()) as
          | ModelTrialContext
          | { error: string };
        if (!res.ok || "error" in data) {
          throw new Error(
            "error" in data ? data.error : `Request failed (${res.status}).`,
          );
        }
        setState({ status: "ready", ctx: data });
        setModel(data.models[0]?.id ?? "");
        setSelected(new Set(data.autoPool.map((c) => c.chunkId)));
        setOverride(data.currentOverride);
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load.",
        });
      });
  }

  function toggleChunk(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Client-side gate mirroring the server's variation validation.
  const shapeInvalid =
    variation !== "model" &&
    (shapeMode === "custom"
      ? customSel === null
      : !Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size);
  const cantRun = (variation !== "size" && !model) || shapeInvalid;

  // The flat POST body for the current variation (kind is derived server-side).
  function variationBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (variation !== "size") body.model = model;
    if (variation !== "model") {
      if (shapeMode === "custom" && customSel) body.sections = [customSel.text];
      else {
        body.size = size;
        body.overlap = overlap;
      }
    }
    return body;
  }

  async function run(save: boolean) {
    if (cantRun) return;
    if (save) setSaving(true);
    else setRunning(true);
    setRunError(null);
    try {
      const res = await apiFetch(`/api/eval/chunks/${chunkId}/try-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...variationBody(),
          poolChunkIds: [...selected],
          save,
        }),
      });
      const data = (await res.json()) as
        | { result: ModelTrialResult; savedTrial: SavedModelTrial | null }
        | { error: string };
      if (!res.ok || "error" in data) {
        setRunError(
          "error" in data ? data.error : `Request failed (${res.status}).`,
        );
        return;
      }
      setResult(data.result);
      if (data.savedTrial) {
        onSaved(data.savedTrial);
        setSavedResult(true);
      } else if (!save) {
        setSavedResult(false); // a plain Run produced a new, unsaved result
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSaving(false);
      setRunning(false);
    }
  }

  // Persist the current variation as this chunk's override for the active
  // config (model / size / size+model), or clear it. Custom drag-border shapes
  // can't be persisted (no override path for arbitrary sections yet).
  async function applyOverride(clear: boolean) {
    if (!clear && variation !== "model" && shapeMode === "custom") return;
    setOvBusy(true);
    setRunError(null);
    try {
      const res = clear
        ? await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
            method: "DELETE",
          })
        : await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(variationBody()),
          });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setRunError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      const baseline = state?.status === "ready" ? state.ctx.baselineModel : "";
      setOverride(clear ? null : variation === "size" ? baseline : model);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setOvBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          onClick={toggleOpen}
          className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
        >
          Try a different configuration
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Try a different configuration
        </span>
        <button
          onClick={toggleOpen}
          className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          ✕
        </button>
      </div>

      {(!state || state.status === "loading") && (
        <p className="mt-2 text-xs text-zinc-400">Loading…</p>
      )}
      {state?.status === "error" && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {state.message}
        </p>
      )}

      {state?.status === "ready" && (
        <div className="mt-2 flex flex-col gap-3 text-xs">
          {/* What to vary: the model, the chunk's shape, or both. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-zinc-500">Vary:</span>
            <VariationPill
              active={variation === "model"}
              onClick={() => setVariation("model")}
            >
              Model
            </VariationPill>
            <VariationPill
              active={variation === "size"}
              onClick={() => setVariation("size")}
            >
              Chunk size
            </VariationPill>
            <VariationPill
              active={variation === "combo"}
              onClick={() => setVariation("combo")}
            >
              Combination
            </VariationPill>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {variation !== "size" && (
              <>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {state.ctx.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-400">
                  vs baseline{" "}
                  <span className="font-mono">{state.ctx.baselineModel}</span>
                </span>
              </>
            )}
            {variation === "size" && (
              <span className="text-zinc-400">
                under baseline{" "}
                <span className="font-mono">{state.ctx.baselineModel}</span>
              </span>
            )}
            <button
              onClick={() => run(false)}
              disabled={running || saving || cantRun}
              className="rounded-md bg-black px-3 py-1 font-medium text-white cursor-pointer transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
            >
              {running ? "Running…" : "Run"}
            </button>
            <button
              onClick={() => applyOverride(false)}
              disabled={
                ovBusy ||
                running ||
                saving ||
                cantRun ||
                (variation === "model" && model === state.ctx.baselineModel) ||
                (variation !== "model" && shapeMode === "custom")
              }
              title={
                variation === "model" && model === state.ctx.baselineModel
                  ? "Can't override to the base model"
                  : variation !== "model" && shapeMode === "custom"
                    ? "Custom-border shapes can't be persisted as an override yet — use a uniform re-split"
                    : "Persist this variation for this chunk's retrieval (RRF-fused)"
              }
              className="rounded-md border border-indigo-300 px-3 py-1 font-medium text-indigo-700 cursor-pointer hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-900/20"
            >
              {ovBusy ? "Saving…" : "Set as override"}
            </button>
          </div>

          {/* Chunk-shape controls: uniform re-split, or drag the chunk's borders. */}
          {variation !== "model" && (
            <div className="flex flex-col gap-2 rounded border border-dashed border-zinc-300 p-2 dark:border-zinc-700">
              <div className="flex gap-2">
                <ModeTab
                  active={shapeMode === "uniform"}
                  onClick={() => setShapeMode("uniform")}
                >
                  Uniform re-split
                </ModeTab>
                <ModeTab
                  active={shapeMode === "custom"}
                  onClick={() => setShapeMode("custom")}
                >
                  Drag borders
                </ModeTab>
              </div>
              {shapeMode === "uniform" ? (
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">size (tokens)</span>
                    <input
                      type="number"
                      min={1}
                      value={size}
                      onChange={(e) =>
                        setSize(Math.floor(Number(e.target.value)))
                      }
                      className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">overlap (tokens)</span>
                    <input
                      type="number"
                      min={0}
                      value={overlap}
                      onChange={(e) =>
                        setOverlap(Math.floor(Number(e.target.value)))
                      }
                      className="w-24 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                    />
                  </label>
                </div>
              ) : state.ctx.questions.length > 0 ? (
                <ChunkBorderPicker
                  questionId={state.ctx.questions[0].questionId}
                  positionHint={state.ctx.chunk.position ?? 0}
                  onSelection={setCustomSel}
                />
              ) : (
                <span className="text-zinc-400">
                  Needs at least one question on this chunk to load the border
                  editor.
                </span>
              )}
            </div>
          )}

          {override && (
            <div className="flex items-center gap-2 rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-900/20 dark:text-indigo-300">
              <span>
                Chunk overridden to{" "}
                <span className="font-mono">{override}</span> for retrieval —
                re-score to see its effect.
              </span>
              <button
                onClick={() => applyOverride(true)}
                disabled={ovBusy}
                className="cursor-pointer underline hover:no-underline disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          )}

          {/* Candidate pool: the chunk (always), its questions' top-k, + corpus */}
          <div className="flex flex-col gap-1">
            <span className="font-medium uppercase tracking-wide text-zinc-500">
              Test pool
            </span>
            <div className="flex flex-wrap items-center gap-1.5 rounded border border-green-300 bg-green-50 px-2 py-1 dark:border-green-900/50 dark:bg-green-900/15">
              <span className="font-medium text-green-700 dark:text-green-400">
                ✓ test chunk
              </span>
              <span className="font-mono text-zinc-500">
                {state.ctx.chunk.fileName} · #{state.ctx.chunk.position ?? "?"}
              </span>
              <span className="text-zinc-400">(always included)</span>
            </div>

            {state.ctx.autoPool.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {state.ctx.autoPool.map((c) => (
                  <PoolRow
                    key={c.chunkId}
                    label={`${c.fileName} · #${c.position ?? "?"}`}
                    preview={c.text}
                    checked={selected.has(c.chunkId)}
                    onToggle={() => toggleChunk(c.chunkId)}
                  />
                ))}
              </ul>
            ) : (
              <span className="text-zinc-400">
                No top-k candidates yet (questions unscored) — add corpus chunks
                below.
              </span>
            )}

            {state.ctx.restCorpus.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5">
                <button
                  onClick={() => setShowCorpus((v) => !v)}
                  className="cursor-pointer self-start text-zinc-500 hover:underline"
                >
                  {showCorpus ? "▾" : "▸"} Rest of corpus (
                  {state.ctx.restCorpus.length})
                </button>
                {showCorpus && (
                  <ul className="flex max-h-48 flex-col gap-0.5 overflow-auto rounded border border-zinc-200 p-1 dark:border-zinc-800">
                    {state.ctx.restCorpus.map((c) => (
                      <PoolRow
                        key={c.chunkId}
                        label={`${c.fileName} · #${c.position ?? "?"}`}
                        preview={c.preview}
                        checked={selected.has(c.chunkId)}
                        onToggle={() => toggleChunk(c.chunkId)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {runError && (
            <span className="text-red-600 dark:text-red-400">{runError}</span>
          )}

          {result && (
            <div className="flex flex-col gap-2">
              <TrialOutcomes
                model={result.model}
                variation={variationLabel(
                  result.kind,
                  result.chunkSize,
                  result.chunkOverlap,
                  result.pieceCount,
                )}
                poolSize={result.poolSize}
                pool={result.pool}
                pieceCount={result.pieceCount}
                questions={result.questions}
              />
              <button
                onClick={() => run(true)}
                disabled={saving || running || savedResult}
                className="self-start cursor-pointer rounded border border-zinc-300 px-2 py-1 font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {savedResult ? "Saved ✓" : saving ? "Saving…" : "Save result"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Per-chunk experiments block, attached to the chunk: the saved "Models tried"
// list (above the add-question form), the add-question form (passed in as
// children so it keeps the dashboard's form state), then the "Try a different
// model" runner. The saved list is the source of truth — the runner reports new
// saves up via onSaved, and deletes happen here. A saved trial's model can be
// promoted to the chunk's DELEGATE (a persisted model override); when one is
// active the config's base model is listed here in yellow as "(baseline)".
function ChunkExperiments({
  chunkId,
  baselineModel,
  overrideInfo,
  onDelegateChange,
  children,
}: {
  chunkId: string;
  baselineModel: string;
  overrideInfo: ChunkOverrideInfo | null;
  onDelegateChange: () => void;
  children: ReactNode;
}) {
  const [saved, setSaved] = useState<SavedModelTrial[]>([]);
  const [delegating, setDelegating] = useState(false);
  const [delegateErr, setDelegateErr] = useState<string | null>(null);

  // A model-kind override = the chunk's delegate model.
  const delegateModel =
    overrideInfo && overrideInfo.kind !== "size" ? overrideInfo.model : null;

  // The override POST body a saved trial maps to; null = not persistable
  // (custom drag-border shapes have no override path yet).
  function overrideBodyFor(t: SavedModelTrial): Record<string, unknown> | null {
    if (t.kind === "model") return { model: t.trialModel };
    if (t.chunkSize == null) return null;
    const body: Record<string, unknown> = {
      size: t.chunkSize,
      overlap: t.chunkOverlap ?? 0,
    };
    if (t.kind === "size+model") body.model = t.trialModel;
    return body;
  }

  // Is this saved trial the chunk's currently-applied override?
  function isApplied(t: SavedModelTrial): boolean {
    if (!overrideInfo) return false;
    if (t.kind === "model") {
      return (
        overrideInfo.kind === "model" && overrideInfo.model === t.trialModel
      );
    }
    if (t.kind === "size") return overrideInfo.kind === "size";
    return (
      overrideInfo.kind === "size+model" && overrideInfo.model === t.trialModel
    );
  }

  // Load the chunk's saved trials once on mount (lightweight — no embeddings).
  useEffect(() => {
    let alive = true;
    apiFetch(`/api/eval/chunks/${chunkId}/trials`)
      .then((res) => res.json())
      .then((data: { trials?: SavedModelTrial[] }) => {
        if (alive && data.trials) setSaved(data.trials);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [chunkId]);

  async function removeSaved(id: string) {
    setSaved((s) => s.filter((t) => t.id !== id)); // optimistic
    await apiFetch(`/api/eval/chunks/${chunkId}/try-model?trialId=${id}`, {
      method: "DELETE",
    }).catch(() => {});
  }

  // Promote a saved trial to this chunk's persisted override (delegate model,
  // size, or combo), or clear it (null) back to the config's base settings. The
  // dashboard reloads so the blue header chip + metrics pick it up; a re-score
  // applies it to the rates.
  async function setDelegate(body: Record<string, unknown> | null) {
    setDelegating(true);
    setDelegateErr(null);
    try {
      const res = body
        ? await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await apiFetch(`/api/eval/chunks/${chunkId}/override`, {
            method: "DELETE",
          });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setDelegateErr(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      onDelegateChange();
    } catch (err) {
      setDelegateErr(err instanceof Error ? err.message : "Network error.");
    } finally {
      setDelegating(false);
    }
  }

  const modelTrials = saved.filter((t) => t.kind === "model");
  const sizeTrials = saved.filter((t) => t.kind === "size");
  const comboTrials = saved.filter((t) => t.kind === "size+model");

  const renderRows = (trials: SavedModelTrial[]) =>
    trials.map((t) => {
      const body = overrideBodyFor(t);
      return (
        <SavedTrialRow
          key={t.id}
          trial={t}
          isApplied={isApplied(t)}
          canApply={body !== null}
          delegating={delegating}
          onApply={() => body && setDelegate(body)}
          onDelete={() => removeSaved(t.id)}
        />
      );
    });

  return (
    <>
      {(saved.length > 0 || delegateModel) && (
        <div className="flex flex-col gap-2 border-t border-zinc-200 px-3 py-2 text-[11px] dark:border-zinc-800">
          {(modelTrials.length > 0 || delegateModel) && (
            <div className="flex flex-col gap-1">
              <span className="font-medium uppercase tracking-wide text-zinc-500">
                Models tried
              </span>
              <ul className="flex flex-col gap-1">
                {/* With a delegate active, the base model moves down here. */}
                {delegateModel && (
                  <li className="flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-900/50 dark:bg-amber-900/15">
                    <span className="font-mono font-medium text-amber-700 dark:text-amber-400">
                      {baselineModel}
                    </span>
                    <span className="text-amber-600 dark:text-amber-500">
                      (baseline)
                    </span>
                    <button
                      type="button"
                      onClick={() => setDelegate(null)}
                      disabled={delegating}
                      title="Clear the delegate — rank this chunk under the base model again"
                      className="ml-auto cursor-pointer text-amber-700 underline hover:no-underline disabled:opacity-50 dark:text-amber-400"
                    >
                      Restore as delegate
                    </button>
                  </li>
                )}
                {renderRows(modelTrials)}
              </ul>
            </div>
          )}
          {sizeTrials.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="font-medium uppercase tracking-wide text-zinc-500">
                Chunk variations
              </span>
              <ul className="flex flex-col gap-1">{renderRows(sizeTrials)}</ul>
            </div>
          )}
          {comboTrials.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="font-medium uppercase tracking-wide text-zinc-500">
                Combination variations
              </span>
              <ul className="flex flex-col gap-1">{renderRows(comboTrials)}</ul>
            </div>
          )}
          {delegateErr && (
            <span className="text-red-600 dark:text-red-400">
              {delegateErr}
            </span>
          )}
        </div>
      )}
      {children}
      <ModelTrial
        chunkId={chunkId}
        onSaved={(t) => setSaved((s) => [t, ...s])}
      />
    </>
  );
}

// One selectable pool chunk: a checkbox plus an expandable text/preview.
function PoolRow({
  label,
  preview,
  checked,
  onToggle,
}: {
  label: string;
  preview: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="cursor-pointer"
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-1 text-left text-zinc-500 hover:underline"
        >
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <span className="font-mono">{label}</span>
        </button>
      </div>
      {open && <ChunkText text={preview} />}
    </li>
  );
}

// Mean cosine similarity of the ground-truth chunk to its questions under the
// trial model — the average of the per-question sims (newScore). A model-level
// read on how tightly this chunk embeds to its own questions, independent of
// whether it cleared the top-k. null when the trial has no questions.
function avgTrialSim(questions: TrialQuestionOutcome[]): number | null {
  if (questions.length === 0) return null;
  return questions.reduce((sum, q) => sum + q.newScore, 0) / questions.length;
}

// Per-question before→after for a trial: each question's stored full-corpus
// result next to its in-pool rank under the trial model. Shared by the live
// result and a saved trial's expansion. (The hits/avg-sim rollup lives in the
// saved-trial header and the chunk card, so it isn't repeated here.)
function TrialOutcomes({
  model,
  variation,
  poolSize,
  pool,
  pieceCount,
  questions,
}: {
  model: string;
  variation?: string; // shape annotation for size/combo trials
  poolSize: number;
  pool: PoolChunk[];
  pieceCount?: number | null;
  questions: TrialQuestionOutcome[];
}) {
  // Which question's top-k is expanded, and which chunk rows within are open.
  const [openQ, setOpenQ] = useState<Record<string, boolean>>({});
  const [openChunk, setOpenChunk] = useState<Record<string, boolean>>({});
  const byId = new Map(pool.map((c) => [c.chunkId, c]));

  return (
    // Font size is inherited: text-xs in the runner, smaller in "Models tried".
    <div className="flex flex-col gap-2">
      <span className="text-zinc-600 dark:text-zinc-400"></span>
      <ul className="flex flex-col gap-1.5">
        {questions.map((q) => {
          const top = q.topPool ?? [];
          const qOpen = openQ[q.questionId] ?? false;
          return (
            <li key={q.questionId} className="flex flex-col gap-0.5">
              <span className="text-zinc-700 dark:text-zinc-300">
                {q.question}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-zinc-500">
                <Badge hit={q.newHit} rank={q.newRank} stale={false} />
                <span className="text-zinc-400">
                  sim {q.newScore.toFixed(3)}
                </span>
                {/* Drill into the re-ranked test pool, like the question top-k.
                    Absent on trials saved before topPool was recorded. */}
                {top.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenQ((o) => ({
                        ...o,
                        [q.questionId]: !o[q.questionId],
                      }))
                    }
                    className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
                  >
                    top-k
                  </button>
                )}
              </span>
              {qOpen && top.length > 0 && (
                <ol className="mt-0.5 flex flex-col gap-1">
                  {top.map((h) => {
                    const meta = byId.get(h.chunkId);
                    const key = `${q.questionId}:${h.chunkId}:${h.subIndex ?? "w"}`;
                    // Size/combo trials rank the test chunk as pieces — label
                    // each with its piece index (text shown is the whole chunk).
                    const pieceTag =
                      h.subIndex != null && pieceCount != null
                        ? ` · piece ${h.subIndex + 1}/${pieceCount}`
                        : "";
                    return (
                      <ChunkRow
                        key={key}
                        chunk={{
                          chunkId: h.chunkId,
                          fileName: `${meta?.fileName ?? "?"}${pieceTag}`,
                          position: meta?.position ?? null,
                          text: meta?.text || "Chunk text unavailable.",
                          rank: h.rank,
                          score: h.score,
                          isExpected: h.isExpected,
                        }}
                        isOpen={openChunk[key] ?? false}
                        onToggle={() =>
                          setOpenChunk((o) => ({ ...o, [key]: !o[key] }))
                        }
                      />
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// One saved trial under the chunk's variations lists: a collapsed headline that
// expands to the per-question before→after, with apply/delegate and delete
// actions.
function SavedTrialRow({
  trial,
  isApplied,
  canApply,
  delegating,
  onApply,
  onDelete,
}: {
  trial: SavedModelTrial;
  isApplied: boolean; // this trial is the chunk's active override/delegate
  canApply: boolean; // false for custom drag-border shapes (not persistable)
  delegating: boolean;
  onApply: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sim = avgTrialSim(trial.results);
  // "Strictly better than baseline": no question regressed and at least one
  // improved — the green-title signal that this variation dominates the base
  // config on everything this chunk was asked.
  const beatsBaseline =
    trial.results.length > 0 &&
    trial.results.every((q) => q.newHit || q.storedHit !== true) &&
    trial.hitCount > trial.storedHitCount;
  const shape = variationLabel(
    trial.kind,
    trial.chunkSize,
    trial.chunkOverlap,
    trial.pieceCount,
  );
  // Headline: the model for model/combo trials, the shape for size trials.
  const headline =
    trial.kind === "size" ? (shape ?? "re-split") : trial.trialModel;
  const subLabel = trial.kind === "size+model" ? shape : undefined;
  const applyLabel =
    trial.kind === "model" ? "Make delegate" : "Apply as override";
  return (
    <li className="flex flex-col gap-1 rounded border border-zinc-200 p-2 dark:border-zinc-800">
      {/* The whole header toggles the row; only the ✕ is a separate target. */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 cursor-pointer flex-wrap items-center gap-1.5 text-left"
        >
          <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
          <span
            title={
              isApplied
                ? "This variation is the chunk's current override"
                : beatsBaseline
                  ? "Beat the baseline config on every question in this trial"
                  : undefined
            }
            className={`font-mono font-medium ${
              isApplied
                ? "text-blue-700 dark:text-blue-400"
                : beatsBaseline
                  ? "text-green-700 dark:text-green-400"
                  : "text-zinc-700 dark:text-zinc-300"
            }`}
          >
            {headline}
          </span>
          {subLabel && <span className="text-zinc-500">{subLabel}</span>}
          {isApplied && (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
              {trial.kind === "model" ? "delegate ✓" : "applied ✓"}
            </span>
          )}
          <span className="text-zinc-500">
            {trial.hitCount}/{trial.questionCount} hit
            {trial.questionCount === 1 ? "" : "s"}
          </span>
          <span className="text-zinc-400">·</span>
          {/* Hover the count to see which chunks made up the test pool. */}
          <PoolTooltip pool={trial.pool}>
            <span className="text-zinc-500 underline decoration-dotted underline-offset-2">
              test pool {trial.poolSize}
            </span>
          </PoolTooltip>
          {sim !== null && (
            <>
              <span className="text-zinc-400">·</span>
              <span className="text-zinc-500">avg sim {sim.toFixed(3)}</span>
            </>
          )}
          <span className="text-zinc-400">
            {new Date(trial.createdAt).toLocaleString()}
          </span>
        </button>
        {!isApplied && (
          <button
            type="button"
            onClick={onApply}
            disabled={delegating || !canApply}
            title={
              canApply
                ? "Persist this variation to represent this chunk in this config and for it's metrics after a re-score"
                : "Custom-border shapes can't be persisted as an override yet"
            }
            className="shrink-0 cursor-pointer rounded border border-blue-300 px-1.5 py-0.5 font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
          >
            {delegating ? "Applying…" : applyLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 cursor-pointer text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
        >
          ✕
        </button>
      </div>
      {open && (
        <TrialOutcomes
          model={trial.trialModel}
          variation={shape}
          poolSize={trial.poolSize}
          pool={trial.pool}
          pieceCount={trial.pieceCount}
          questions={trial.results}
        />
      )}
    </li>
  );
}

// Hover card listing a trial's test-pool chunks (document · #position). The card
// sits below the trigger inside the same hover group — a transparent pad bridges
// the gap so the pointer can reach it — and scrolls when the pool is large.
function PoolTooltip({
  pool,
  children,
}: {
  pool: PoolChunk[];
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-block">
      {children}
      <span className="absolute left-0 top-full z-20 hidden pt-1 group-hover:block">
        <span className="flex w-64 flex-col gap-0.5 rounded border border-zinc-200 bg-white p-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <span className="mb-0.5 font-medium uppercase tracking-wide text-zinc-500">
            Test pool · {pool.length} chunk{pool.length === 1 ? "" : "s"}
          </span>
          <span className="flex max-h-48 flex-col gap-0.5 overflow-auto">
            {pool.map((c) => (
              <span
                key={c.chunkId}
                className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400"
              >
                <span className="truncate font-mono">{c.fileName}</span>
                <span className="shrink-0 text-zinc-400">
                  · #{c.position ?? "?"}
                </span>
              </span>
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}
